# ระบบทดสอบ FloCafe2 ↔ QR Server (pos-server)

> เอกสารออกแบบ (design proposal) — ยังไม่มีการสร้างโค้ดทดสอบตามเอกสารนี้
> อ้างอิง 2 ภาพ: (1) วงจรธุรกิจ Customer QR Order → … → Receipt → Cloud Reconciliation
> (2) delivery pipeline Customer QR Order → Elysia API → PostgreSQL Transaction → Durable Outbox →
> Outbox Dispatcher → Redis Queue / Wake-up → Delivery Worker → Local Connector → Connector Inbox /
> Dedup → FloCafe POS → POS ACK → Cloud Delivery Status (+ Recovery scan)

## 0. บทสรุป

| หัวข้อ | ข้อสรุป |
| --- | --- |
| เป้าหมาย | พิสูจน์ 2 อย่าง: (A) วงจรธุรกิจสั่ง→ครัว→ชำระ→ปิดบิลครบ (B) **การส่งงานไม่หาย ไม่ซ้ำ และสถานะที่ลูกค้าเห็นเป็นความจริง** แม้ Redis หาย, worker ตาย, ACK หลุด หรือ connector รีสตาร์ท |
| ขอบเขต | pos-server (Elysia + Postgres + outbox + dispatcher + delivery worker), Redis, connector + inbox/dedup, FloCafe Server App, Caddy |
| ระบบภายใต้การทดสอบ | `pos-server/` ทั้งกอง, `pos-server/connector/flocafe.ts`, FloCafe2 (`node dev-server.js` :3001/:3002/:3003), `deploy/Caddyfile` |
| งบเวลา | PR ≤ 10 นาที · nightly ≤ 45 นาที · weekly ≤ 6 ชั่วโมง · release ≥ 24 ชั่วโมง soak |
| ตัวชี้วัดความสำเร็จ | P1 cases อัตโนมัติ 100%, รันซ้ำ 10 ครั้งเขียวติด, mutation 8 ตัวต้องแดง, ไม่มีขั้นตอน manual |
| ความเสี่ยงสูงสุด | (1) pipeline ในภาพยังไม่มีในโค้ด (F-07) (2) connector ชน rate limit ของ FloCafe (F-01) (3) งานค้าง/ACK หลุดแล้วมองไม่เห็น (F-02) |

### 0.1 หลักคิด 6 ข้อ

1. **ทดสอบที่รอยต่อ** — mock ได้เฉพาะ FloCafe ในชั้น L2; L3 ต้องเป็น FloCafe จริง (`node dev-server.js`) และ Redis จริง
2. **ทุก suite ต้อง fail ได้** — FloCafe ใช้ `assertOrThrow`, ฝั่ง Bun ใช้ exit code; ห้ามใช้ตัวนับ report-only อย่างเดียว
3. **ผูกกับ invariant** — "ตอบ 201 แล้วต้องมี orders 1 + order_item ≥ 1 + outbox 1 + delivery 1 และต้องถึง POS ภายในเวลาที่กำหนด" ไม่ใช่ดูแค่ status code
4. **Fault injection ต้อง deterministic** — ใช้ fault proxy ที่คุมจำนวนครั้ง/เวลาได้ ไม่พึ่ง `sleep` แล้วหวังผล
5. **Redis เป็นของที่หายได้** — สัญญาของระบบคือ "Postgres คือแหล่งความจริง, Redis เป็นเพียง wake-up"; เทสต้องทำลาย Redis แล้วพิสูจน์ว่าไม่มีออเดอร์หาย
6. **ทดสอบฝั่ง local ก่อนเสมอ** — FloCafe ต้องขายได้แม้คลาวด์ล่ม (invariant ข้อ 1 ของ AGENTS.md)

### 0.2 Baseline findings

| ID | หลักฐาน | ผลกระทบ | เทสที่จะจับ |
| --- | --- | --- | --- |
| F-01 | `connector/flocafe.ts:86` สร้าง `new Http(cfg)` ทุกครั้งที่ `runOnce()` → login ใหม่ทุก 1.5 วินาที (`:160-165`); FloCafe จำกัด login 10 ครั้ง/15 นาที/IP (`main/middleware/security.ts:89-97`) และ `/api` ทั้งหมด 150 ครั้ง/นาที/IP (`main/server-app.ts:294`) | connector ได้ 429 ภายใน ~15 วินาที ทุกอย่างล้มตาม แม้มีบิลเปิดใบเดียว | E2E-01, PERF-06 |
| F-02 | `routes/connector.ts:33` กรอง `attempts < 8`; ครบ 8 แล้วยัง `status='pending'` ไม่มี `failed`/alert | งานค้างถาวรแบบมองไม่เห็น | §7.4 D-INV-1, CHAOS-C9 |
| F-03 | `worker.ts:10-35` mark `processed_at` หลัง adapter ทำงาน; adapter เป็น stub log (`adapters/index.ts`) | at-least-once; adapter ต้อง idempotent ไม่งั้นซ้ำ | CHAOS-C4 |
| F-04 | `connector/flocafe.ts:26` รับ `cfg.posUrl` ได้ทุก scheme | token หลุดถ้าใช้ `http://` | SEC-EDGE-09 |
| F-05 | pos-server ไม่มี metrics (`api.ts:41` มีแค่ `/healthz`) | วัด delivery lag/queue/pool ไม่ได้ | PERF-01 (ต้องเพิ่ม) |
| F-06 | `outbox` ไม่มี RLS และ `pos_app` อ่านได้ทุก tenant (`001_init.sql:94-105`) | รับได้ถ้า payload มีแต่ id — ต้องมีเทสกัน PII | SEC-DATA-01 |
| **F-07** | **ยังไม่มี Redis / Outbox Dispatcher แยก / Delivery Worker / Connector Inbox / POS ACK เป็นทางการ / Cloud Delivery Status / Recovery scan** — โค้ดปัจจุบันเป็น pull ล้วน (`GET /api/connector/jobs` + lease 60 s, `pos_forward.status`) | ภาพคือ **target architecture** ไม่ใช่ as-is; ถ้าเขียนเทสอิงโค้ดปัจจุบันจะไม่ได้ทดสอบสิ่งที่ภาพสัญญา | §1.4, ชั้น L1.5 contract |
| **F-08** | ไม่มีสถานะ "ส่งถึงร้านแล้ว" ให้ลูกค้าเห็น — `GET /api/orders` คืนเฉพาะ `orders.status` (ครัว) | ลูกค้าไม่รู้ว่าออเดอร์ถึงร้านหรือยัง; ACK กับสถานะครัวปนกัน | D-INV-7, SEC-STATUS-01 |

> F-01 **แก้แล้ว**: connector เก็บ `Http`/JWT ไว้ข้ามรอบ (login ครั้งเดียวต่อโปรเซส) และ Server App
> อ่านเพดานรวมจาก `FLO_SERVER_APP_GLOBAL_RATE_LIMIT_MAX` (ค่าเริ่มต้น 150 คงเดิม)
> หลักฐาน: connector test ยืนยัน `logins === 1` และ e2e รันผ่านด้วยเพดานจริง 150/นาที
>
> E2E-01 เขียนแล้วและ**เขียว** (ดู §0.3) — ไม่ต้องรอ F-01 อีก

### 0.3 สถานะการดำเนินการ (Phase 0)

| สิ่งที่ทำแล้ว | ที่อยู่ | หลักฐาน |
| --- | --- | --- |
| Contract: envelope/ACK/state/dedup/recovery + validator | `tests/qr-server/harness/delivery.ts` | contract suite 28 checks เขียว |
| Transport sim: auth, duplicate, lost ACK, restart, stale, foreign store | `harness/fake-cloud.ts`, `harness/fake-connector.ts` | sim suite 7 checks เขียว |
| Wake queue + lease | `harness/fake-redis.ts` | contract suite |
| **API integration (L2)**: order→outbox→delivery row, idempotency, connector ACK, ACK spoof, ack failure/lease, per-bill order, outbox drain, RLS, body limit | `tests/qr-server/suites/api/` + `harness/db.ts` | **api suite 18 checks เขียว** บน Postgres 18 จริง |
| **E2E (L3)**: guest order → connector → FloCafe จริง → สร้างบิล → ชำระ → ปิดบิลคลาวด์ | `tests/qr-server/suites/e2e/` | **e2e ผ่าน**: connector ส่งออเดอร์, FloCafe ได้ product/จำนวนถูก, จ่ายแล้วคลาวด์ปิดบิล (closed=1) |
| **F-01 fix**: cache JWT + Retry-After + global limit env | `connector/flocafe.ts`, `main/server-app.ts` | connector test `logins === 1`; e2e ผ่านที่เพดาน 150/นาที |
| Compose + Caddy + db bootstrap + FloCafe image | `tests/qr-server/compose/` | ผ่าน `docker compose config`; ยังไม่ `up` (Docker daemon ปิดในเครื่องนี้) |
| npm scripts | `package.json` | `test:qr-server`, `:contract`, `:sim`, `:api`, `:e2e` |

ยังไม่ทำ: dispatcher/delivery-worker/inbox จริง (Phase 2), suite `security`/`perf`/`chaos`
(Phase 3–4) — เทสของจริงจะแดงจนกว่า pipeline จะถูก implement

## 1. สถาปัตยกรรม

### 1.1 แผนที่ภาพ delivery pipeline → โค้ด

| องค์ประกอบในภาพ | ที่อยู่จริงวันนี้ | สถานะ |
| --- | --- | --- |
| Customer QR Order | `pos-server/web/` + FloCafe guest UI | มี flow, UI ตัวอย่าง |
| Elysia API | `src/api.ts`, `src/routes/{guest,staff,connector}.ts` | มี |
| PostgreSQL Transaction | `withTenant()` (`src/db.ts`) + `orders`/`order_item`/`outbox`/`pos_forward` | มี |
| Orders Table | `orders`, `order_item` | มี |
| Durable Outbox Table | `outbox` + index `outbox_pending` | มี |
| Outbox Dispatcher | `src/worker.ts` (ปัจจุบันยิง adapter ตรง ไม่ผ่าน Redis) | **ต่างจากภาพ** |
| Redis Queue / Wake-up | — | **ไม่มี** (`package.json` มีแค่ elysia + postgres) |
| Delivery Worker | — (มี outbox worker ที่เป็น adapter stub) | **ไม่มี** |
| Local Connector | `connector/flocafe.ts` (pull ทุก 1.5 s) | มีけど **pull ไม่ใช่ push** |
| Connector Inbox / Dedup | — (ปัจจุบันใช้ FloCafe `Idempotency-Key` อย่างเดียว) | **ไม่มี** |
| FloCafe POS | `main/server-app.ts` :3003 (`POST /api/orders`, `/:id/items`, `GET /:id`) | มี |
| POS ACK | `POST /api/connector/jobs/:id/result` (ฝั่งคลาวด์) | มีบางส่วน แต่ไม่มี envelope/สถานะ ACK |
| Cloud Delivery Status | `pos_forward.status` + `bill.pos_order_id` | มีบางส่วน ไม่มี state machine/guest view |
| Recovery scan | — | **ไม่มี** |

### 1.2 Delivery pipeline (เป้าหมาย)

```mermaid
flowchart LR
  G[ลูกค้า] --> API[Elysia API]
  API --> TX[(PostgreSQL Transaction)]
  TX --> ORD[Orders]
  TX --> OUT[Durable Outbox]
  OUT --> DISP[Outbox Dispatcher]
  DISP --> Q[Redis Queue / Wake-up]
  DISP -.-> SCAN[Recovery scan]
  Q --> DW[Delivery Worker]
  DW --> CON[Local Connector]
  CON --> INB[Connector Inbox / Dedup]
  INB --> POS[FloCafe POS]
  POS --> ACK[POS ACK]
  ACK --> DW
  ACK --> ST[Cloud Delivery Status]
  OUT -.-> SCAN
  SCAN -.-> DW
```

#### สัญญาที่ต้องพิสูจน์จากภาพนี้

1. `Outbox` ถูกเขียนในทรานแซกชันเดียวกับ `Orders` → ไม่มีออเดอร์ที่ไม่มีงานส่ง และไม่มีงานส่งที่ไม่มีออเดอร์
2. Redis หายทั้งก้อนได้ → Recovery scan หยิบงานที่ยังไม่ ACK มาส่งใหม่ภายในเวลาที่กำหนด
3. ส่งซ้ำได้ (at-least-once) → Connector Inbox dedup + FloCafe idempotency ทำให้ POS สร้างออเดอร์ครั้งเดียว
4. Delivery Worker ไม่เชื่อ payload ในคิว — อ่านสถานะจริงจาก Postgres ก่อนส่ง (กันคิวถูกแก้)
5. `Cloud Delivery Status` เปลี่ยนได้จาก ACK จริงเท่านั้น และต้องไม่ถอยหลัง
6. ลำดับต่อบิล: ออเดอร์ที่ 2 ของบิลต้องไม่ถึง POS ก่อนออเดอร์ที่ 1

### 1.3 ลำดับเหตุการณ์ (เป้าหมาย)

```mermaid
sequenceDiagram
  autonumber
  participant G as ลูกค้า
  participant API as Elysia API
  participant PG as Postgres
  participant D as Dispatcher
  participant R as Redis
  participant W as Delivery Worker
  participant K as Connector
  participant I as Inbox/Dedup
  participant F as FloCafe :3003

  G->>API: POST /api/orders (Idempotency-Key)
  API->>PG: BEGIN orders + order_item + outbox + delivery
  PG-->>API: COMMIT
  API-->>G: 201 accepted (delivery=pending)
  D->>PG: poll outbox (SKIP LOCKED)
  D->>R: enqueue wake-up {deliveryId, storeId}
  W->>R: consume (lease/claim)
  W->>PG: re-read order + delivery state
  W->>K: deliver envelope
  K->>I: dedup check (store_id, order_id)
  alt ครั้งแรก
    I->>F: POST /api/orders (Idempotency-Key)
    F-->>I: order id + items
    I->>I: store ACK result
  else ซ้ำ
    I-->>K: replay ACK ที่เก็บไว้
  end
  K-->>W: ACK {deliveryId, posOrderId}
  W->>PG: delivery=acked, pos_order_id
  W-->>G: SSE delivery.acked
```

### 1.4 Delta: ปัจจุบัน (pull) → เป้าหมาย (push + inbox + ACK)

| ขั้น | เป้าหมาย | ปัจจุบัน | งานที่ต้องทำก่อนเริ่ม L1.5 |
| --- | --- | --- | --- |
| enqueue | dispatcher → Redis | `worker.ts` ยิง adapter ตรง | แยก dispatcher, เพิ่ม Redis client |
| queue | Redis wake-up (id เท่านั้น) | — | Wake list/stream + recovery scan (§1.6) |
| worker | Delivery Worker มี lease/partition | — | สร้าง worker + per-bill serialization |
| transport | WS ยาวที่ connector ต่อออกไป | connector pull `GET /jobs` | §1.6 (ตัดสินใจแล้ว) |
| dedup | Connector Inbox | ไม่มี | SQLite inbox `(store_id, order_id)` unique + เก็บ ACK |
| ACK | envelope + สถานะ | `POST /jobs/:id/result` | นิยาม envelope/สถานะ + idempotent ACK |
| status | Cloud Delivery Status | `pos_forward.status` | state machine + มุมมองลูกค้า |
| recovery | scan งานค้าง | — | job + index + metric |

> ถ้ายังไม่พร้อมสร้างทั้ง pipeline ให้ทำ **contract-first**: นิยาม envelope/สถานะ/invariant (§8) แล้วเขียน
> เทส L1.5/L2 กับ double ของ Redis และ connector ก่อน — เทสจะแดงจนกว่าจะ implement ครบ ซึ่งเป็นเป้าที่ต้องการ

### 1.5 Deployment profile

| Profile | การตั้งค่า | ใช้เมื่อ |
| --- | --- | --- |
| A. Connector-only | `require_open=false`, `require_confirm=false`, `pos_forward=true` | ร้านใช้ FloCafe หน้าจอเดียว |
| B. Cloud staff + connector | `require_open=true`, `require_confirm=true` | ร้านใช้หน้าจอพนักงานคลาวด์ร่วม |
| C. Migration | pull และ push เปิดพร้อมกัน (ชั่วคราว) | ระหว่างย้ายระบบ — ต้องพิสูจน์ว่าไม่มีออเดอร์ซ้ำสองเส้นทาง |

### 1.6 Transport contract (ตัดสินใจแล้ว: WS ออกจากร้าน)

เลือก **WS ยาวที่ connector เป็นฝ่ายต่อออกไป** เพื่อคงหลัก "ไม่มี inbound port ที่ร้าน" และใช้ token ชุดเดียวกับ `/api/connector/*`

| ข้อ | กติกา |
| --- | --- |
| Endpoint | `wss://<cloud>/api/connector/stream` + `Authorization: Bearer <connector token>` (HTTPS เท่านั้น ยกเว้น loopback ในเทส) |
| Handshake | server ตอบ `{type:'ready', storeId, serverTime}` ภายใน 3 วินาที; ไม่มี = ปิด connection |
| ข้อความ | server → store: `deliver {envelope}` · store → server: `ack {ack}` หรือ `error {deliveryId, code}` |
| Heartbeat | `ping`/`pong` ทุก 25 วินาที; ขาด 2 รอบ → ตัดแล้ว reconnect backoff 1–30 วินาที |
| อายุ envelope | เก่ากว่า 10 นาที หรือเลย `deadlineAt` → `envelope_expired` |
| ร้านผิด | `store_mismatch` (ไม่แตะ POS) |
| ACK timing | ต้องมาภายใน `deadlineAt` + 2 นาที ไม่งั้น `ack_too_late` |
| ความสัมพันธ์ | ACK ต้องตรง `deliveryId`, `orderId`, `storeId` ของ envelope |
| 1 ร้าน 1 สาย | connection ใหม่แทนที่ของเก่า; split-brain ยังกันซ้ำด้วย inbox + FloCafe idempotency |

| ID | ชั้น | กรณี | คาดหวัง |
| --- | --- | --- | --- |
| TRANS-01 | L1.5 | ต่อด้วย token ถูกต้อง | `ready` + รับ envelope ได้ |
| TRANS-02 | L1.5 | ส่งออเดอร์เดิม 3 ครั้ง (deliveryId ต่างกัน) | POS สร้าง 1 ออเดอร์, ACK เดียวกัน |
| TRANS-03 | L1.5 | ACK หลุด 1 ครั้ง แล้วส่งใหม่ | replay จาก inbox, ไม่สร้าง POS ซ้ำ |
| TRANS-04 | L1.5 | connector รีสตาร์ทโดยมี inbox เดิม | ไม่สร้าง POS ซ้ำ |
| TRANS-05 | L1.5 | envelope เก่า 20 นาที / เลย deadline | `envelope_expired`, ไม่ถึง POS |
| TRANS-06 | L1.5 | envelope ของร้านอื่น | `store_mismatch`, ไม่ถึง POS |
| TRANS-07 | L1.5 | token ผิด/ไม่มี | ปิด connection 4001 |

## 2. ข้อจำกัดของ repo ที่ออกแบบต้องเคารพ

- **ตำแหน่งไฟล์ทดสอบ**: `scripts/ci/validate-test-script-coverage.cjs` สแกนไม่เรียกซ้ำ เฉพาะ `tests/*.test.*` ชั้นเดียว → `tests/qr-server/**` ไม่ทำให้ coverage แดง แต่ต้องมีสคริปต์/CI job ของตัวเอง
- **สอง runtime**: FloCafe = Node 22 + `better-sqlite3`; pos-server = Bun 1.4 → ห้าม import ข้าม runtime ให้คุยผ่าน HTTP/Redis
- **ห้าม Electron**: `node dev-server.js` รัน backend ครบ 3 พอร์ต; ต้อง `npm run build`
- **พอร์ตชน**: 3001/3002/3003 → ใช้ `npm run clean` หรือ env `PORT`/`KDS_PORT`/`SERVER_APP_PORT`
- **ห้ามข้อมูลจริง/secret จริง**: credential ใน harness สร้างตอนรันและห้ามลง log
- **Windows dev**: Docker daemon ไม่ทำงาน, ไม่มี Caddy/k6 → L4 รัน CI Linux; T0 ใช้ HTTP ตรง

## 3. ชั้นทดสอบ

| ชั้น | ขอบเขต | รันด้วย | เวลา | ประตู | จับอะไร |
| --- | --- | --- | --- | --- | --- |
| L0 Static/unit | typecheck, crypto, policy, envelope schema | `bun test`, `npm run lint` | ≤ 2 นาที | PR | regression ตรรกะ, secret |
| L1 DB/contract | migration, RLS, constraint, outbox/delivery state | Postgres 16 | ≤ 3 นาที | PR | schema drift, RLS รั่ว |
| **L1.5 Delivery contract** | envelope, ACK, dedup, state machine กับ double (Redis/connector ปลอม) | Node/Bun harness | ≤ 4 นาที | PR | สัญญา pipeline ก่อนของจริง |
| L2 API integration | ทุก endpoint กับ FloCafe ปลอม + Redis จริง | compose | ≤ 8 นาที | PR | สิทธิ์, limit, สถานะ, dedup |
| L3 E2E จริง | pos-server + Redis + dispatcher + worker + connector + FloCafe จริง + KDS | Node harness + compose | ≤ 20 นาที | nightly | วงจรจริง, การชำระเงิน, ACK |
| L4 Edge/TLS | Caddy, TLS, header, ZAP, testssl | compose + ZAP | ≤ 25 นาที | nightly/weekly | misconfig |
| L5 Perf/chaos/soak | โหลด, fault, Redis loss, soak | load driver + fault proxy | 30 นาที–6 ชม. | weekly/release | คอขวด, recovery, leak |

**E2E-01 (smoke แรก)**: 1 ออเดอร์ → commit → delivery ถึง FloCafe จริงภายใน 10 วินาที → ACK → `delivery=acked`
**D-01 (delivery smoke)**: 10 ออเดอร์ติดกัน → 10/10 ถึง POS, 0 ซ้ำ, ACK ครบใน 5 วินาที

## 4. สถาปัตยกรรมระบบทดสอบ

### 4.1 ภาพรวม

```mermaid
flowchart TB
  subgraph CP[Control plane — tests/qr-server]
    RUN[Runner: Node + bun]
    ORCH[stack orchestrator]
    SEED[seed & fixtures]
    FAULT[fault proxy]
    LOAD[delivery + api load]
    INV[invariant checker]
    ART[(artifacts)]
  end
  subgraph SUT[SUT — docker compose]
    API[Elysia API :3001/:3002]
    PG[(Postgres 16)]
    D[Dispatcher]
    R[(Redis 7)]
    W[Delivery Worker]
    CON[Connector + inbox SQLite]
    FLO[FloCafe dev-server :3003]
    KDS[KDS :3002]
    CAD[Caddy]
  end
  RUN --> ORCH --> SUT
  SEED --> PG
  SEED --> FLO
  LOAD --> CAD --> API --> PG --> D --> R --> W --> CON --> FLO --> KDS
  INV --> PG
  INV --> ART
```

### 4.2 โครงสร้างไฟล์

```text
tests/qr-server/
  README.md                    # สถานะ + วิธีรัน (มีแล้ว)
  compose/
    docker-compose.test.yml    # postgres + redis + api + caddy (+ e2e/pipeline profiles)
    Dockerfile.flocafe         # npm ci + build + dev-server
    Dockerfile.flocafe.dockerignore
    db-setup.test.sql          # role pos_migrate/pos_app + database pos
    Caddyfile.test             # tls internal, header, 128KB
  harness/
    delivery.ts                # สัญญา envelope/ACK/state (มีแล้ว)
    db.ts                      # Postgres client + table-token helper (มีแล้ว)
    fake-redis.ts              # wake queue + lease (มีแล้ว)
    fake-connector.ts          # inbox/dedup + drop-ack (มีแล้ว)
    fake-cloud.ts              # WS server + auth + ack correlation (มีแล้ว)
    fake-flocafe.ts            # คู่สัญญา FloCafe + fault knob (planned)
    fake-connector-e2e.ts      # connector จริงแบบ in-process (planned)
    stack.ts  seed-pos.ts  seed-flocafe.ts  fault-proxy.ts  invariants.ts  (planned)
  suites/
    run.cjs                    # runner (มีแล้ว)
    contract/                  # L1.5 contract (มีแล้ว)
    sim/                       # L1.5 transport (มีแล้ว)
    api/                       # L2 Postgres + Bun API (มีแล้ว)
    e2e/  security/  reliability/  perf/  (planned)
  fixtures/tenants.json        # planned
```

### 4.3 องค์ประกอบ

| องค์ประกอบ | หน้าที่ | เทคโนโลยี |
| --- | --- | --- |
| `delivery.ts` | นิยาม TypeScript ของ envelope/ACK/state + validator ที่ทุกฝั่งใช้ | TS (single source of truth) |
| `fake-redis.ts` | คุม lease, ซ้ำ, latency, loss โดยไม่ต้องมี Redis จริง | in-memory TS (Node/Bun) |
| `fake-connector.ts` | จำลอง inbox/dedup + ตอบ ACK (มี drop-ack knob) | Node + `ws` |
| `fake-cloud.ts` | WS server ที่ตรวจ token, ส่ง envelope, จับคู่ ACK | Node + `ws` |
| `fake-flocafe.ts` | คู่สัญญา FloCafe + fault knob | Bun.serve |
| `fault-proxy.ts` | คั่น connector ↔ cloud / worker ↔ connector | Bun |
| load drivers | สร้าง table token ด้วย `src/crypto.ts` จริง + ถือ SSE + วัด delivery lag | Bun |
| `invariants.ts` | SQL + API + Redis key allowlist | SQL/HTTP |

### 4.4 สภาพแวดล้อม

| Env | ที่ตั้ง | องค์ประกอบ | ใช้กับ |
| --- | --- | --- | --- |
| T0 | dev Windows | pos-server :3001 + Postgres + FloCafe :3003 (host), ไม่มี Redis → ใช้ `fake-redis` | L0–L1.5 |
| T1 | CI ubuntu-24.04 | compose + Postgres + Redis (ไม่มี TLS) | PR (L1–L2) |
| T2 | nightly | + Caddy `tls internal` + FloCafe build จริง | L3–L4 |
| T3 | เครื่องแยก 4 vCPU | + fault proxy + load driver คนละ host | L5 |

### 4.5 Docker Compose (โครง)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: test-only
    volumes:
      - ./db-setup.test.sql:/docker-entrypoint-initdb.d/01-roles.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d pos"]
      interval: 2s
      retries: 30
  redis:
    image: redis:7-alpine
    command:
      - redis-server
      - --requirepass
      - ${REDIS_PASSWORD:-test-only}
      - --appendonly
      - "yes"
      - --maxmemory
      - 256mb
      - --maxmemory-policy
      - noeviction
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD:-test-only}", "ping"]
      interval: 2s
      retries: 30
  migrate:
    image: oven/bun:1.4
    depends_on: { postgres: { condition: service_healthy } }
    working_dir: /app
    volumes: ["../../../pos-server:/app"]
    environment:
      ADMIN_DATABASE_URL: postgres://pos_migrate:mig_pw@postgres:5432/pos
    command: sh -c "bun run src/migrate.ts"
  api1: &api
    image: oven/bun:1.4
    depends_on:
      migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    working_dir: /app
    volumes: ["../../../pos-server:/app"]
    environment: &api_env
      DATABASE_URL: postgres://pos_app:app_pw@postgres:5432/pos
      REDIS_URL: redis://:${REDIS_PASSWORD:-test-only}@redis:6379/0
      GUEST_QR_SECRET: ${GUEST_QR_SECRET:?32 chars}
      BASE_DOMAIN: localhost
      NODE_ENV: development
      HOST: 0.0.0.0
      PORT: "3001"
    command: bun run src/api.ts
  api2:
    <<: *api
    environment:
      <<: *api_env
      PORT: "3002"
  dispatcher:
    image: oven/bun:1.4
    depends_on: { migrate: { condition: service_completed_successfully }, redis: { condition: service_healthy } }
    working_dir: /app
    volumes: ["../../../pos-server:/app"]
    environment: *api_env
    command: bun run src/dispatcher.ts
  delivery-worker:
    image: oven/bun:1.4
    depends_on: [dispatcher]
    working_dir: /app
    volumes: ["../../../pos-server:/app"]
    environment: *api_env
    command: bun run src/delivery-worker.ts
  flocafe:
    build: { context: ../.., dockerfile: tests/qr-server/compose/Dockerfile.flocafe }
    environment:
      FLO_DEV_USER_DATA: /data
      FLO_MATRIX_OFFLINE: "1"
      FLO_WHATSAPP_SOCKET_DISABLED: "1"
      FLO_SERVER_APP_API_RATE_LIMIT_MAX: "100000"
    ports: ["3003:3003"]
  connector:
    image: oven/bun:1.4
    depends_on: [delivery-worker, flocafe]
    working_dir: /app
    volumes: ["../../../pos-server:/app"]
    environment:
      POS_URL: http://api1:3001
      POS_DEV_SLUG: demo
      FLO_URL: http://flocafe:3003
      FLO_EMAIL: server@shop
      FLO_PASSWORD: ${FLO_PASSWORD:?test-only}
      CONNECTOR_INBOX: /data/inbox.sqlite
    command: bun run connector/flocafe.ts
```

> `src/dispatcher.ts` / `src/delivery-worker.ts` เป็นไฟล์เป้าหมาย (ยังไม่มี) — compose นี้คือ "สเปกที่ต้องทำให้รันได้"
> ไฟล์จริงอยู่ที่ `tests/qr-server/compose/docker-compose.test.yml` (บล็อกนี้เป็น excerpt) และมี
> profile `e2e` (FloCafe + connector) กับ `pipeline` (dispatcher/delivery-worker เป้าหมาย) แยกไว้
> `Dockerfile.flocafe` ต้อง `npm ci` + `npm run build` **ใน container** เพราะ `better-sqlite3` ผูก OS
> Redis ตั้งค่าผ่าน command flags (`requirepass`, `maxmemory 256mb`, `noeviction`, `appendonly yes`);
> เทส eviction (CHAOS-C15) ใช้ profile `lossy` ที่ลด `maxmemory` และเปลี่ยน policy เป็น `allkeys-lru`

### 4.6 Redis test profiles

| Profile | การตั้งค่า | ใช้กับ |
| --- | --- | --- |
| normal | `appendonly yes`, `maxmemory 256mb`, `noeviction` | L2, L3 |
| lossy | `appendonly no`, `maxmemory 16mb`, `allkeys-lru` | C13, C14, C15 |
| partitioned | proxy ตัดการเชื่อมต่อ 30–120 s | C6, C17 |

### 4.7 การบูต FloCafe จริง

```bash
npm ci
npm run build
export FLO_DEV_USER_DATA="$(mktemp -d)"
export FLO_MATRIX_OFFLINE=1 FLO_WHATSAPP_SOCKET_DISABLED=1
node dev-server.js        # :3001 :3002 :3003
```

- เปิด Server App + สร้างผู้ใช้บทบาท `server`/`manager` (permission `server-app.use`) ให้ connector login
- สร้างสินค้า/โต๊ะ แล้วผูก `pos_product_id` / `pos_table_id`
- ทดสอบพิมพ์ KOT ใช้ network printer stub เดิม ไม่เปิดเครื่องพิมพ์จริง

**เพดาน rate limit ของ Server App**: connector เรียก FloCafe 1 ครั้งต่อบิลที่เปิดอยู่ทุกรอบ 1.5 วินาที
(≈ 40 × จำนวนบิล ครั้ง/นาที) จึงต้องตั้ง `FLO_SERVER_APP_GLOBAL_RATE_LIMIT_MAX` (ค่าเริ่มต้น 150) และ
`FLO_SERVER_APP_API_RATE_LIMIT_MAX` (ค่าเริ่มต้น 600) ให้ ≥ 60 × จำนวนบิลสูงสุด + margin
e2e รันด้วยค่าเริ่มต้น 150 กับ 1 บิล เพื่อยืนยันว่าการ cache JWT แก้ปัญหา login storm ได้จริง

### 4.8 Fixtures

| Fixture | รายละเอียด |
| --- | --- |
| tenant A | 20 โต๊ะ (18 ผูก POS), 40 เมนู (38 ผูก, 1 ปิดขาย), staff 4 บทบาท, connector token |
| tenant B | เหมือน A แต่ id ต่าง — ทดสอบข้ามร้าน |
| delivery edges | บิลเดียว 20 ออเดอร์ (ลำดับ), 200 ออเดอร์ใน 10 บิล (backlog), ออเดอร์ที่โต๊ะ/เมนูไม่ผูก (permanent fail) |
| failure | FloCafe 409 (โต๊ะถูกใช้), 422 validation, 401 (JWT หมดอายุ), 429, 500 |
| เวลา | ตั้ง `reset_time` เป็นเวลาปัจจุบัน + backdate `last_reset_on` แทน fake clock |

### 4.9 Isolation และหลักฐาน

- หนึ่งรอบ = compose project `qr-<runId>` + DB ใหม่ + `FLO_DEV_USER_DATA` ใหม่ + Redis namespace `qr:<runId>`
- teardown ด้วย `down -v` ใน `finally` แม้เทสล้ม
- เก็บ: log ทุก service, Redis `INFO`/`SLOWLOG` snapshot, `pg_stat_statements`, delivery timeline ต่อออเดอร์, junit, load summary
- ห้ามแตะข้อมูลนอก compose network

## 5. แผนทดสอบความปลอดภัย

### 5.1 Threat model

| Trust boundary | ภัยคุกคาม | มาตรการที่มี/ต้องมี | เทส |
| --- | --- | --- | --- |
| Internet → Caddy | ยิงถล่ม, TLS downgrade | Caddy TLS/HSTS/limit | SEC-EDGE-01..07 |
| Caddy → API | ปลอม `X-Real-IP` | bind loopback + Caddy เขียนทับ | SEC-AB-06 |
| API → Redis | Redis ถูกเข้าถึงจากภายนอก/อ่าน payload | bind loopback + requirepass + payload มีแต่ id | SEC-Q-01/02 |
| Dispatcher/Worker → connector | envelope ถูกแก้/DOS | worker อ่าน DB ซ้ำ, connector auth, rate limit | SEC-Q-03, SEC-ACK-01 |
| Connector → FloCafe | token หลุดทาง HTTP | บังคับ https (F-04) | SEC-EDGE-08/09 |
| Connector inbox | poisoning/แก้ dedup ให้ข้ามออเดอร์ | unique(store,order) + เขียนได้จาก ACK จริงเท่านั้น | SEC-INBOX-01/02 |
| Guest → API | ใช้ซ้ำ QR, ข้าม cooldown/quota | HMAC, device token, epoch, idempotency | SEC-AUTH-05..09, SEC-AB-01..05 |
| Worker → DB | อ่าน outbox ข้ามร้าน | ไม่มี RLS (โดยตั้งใจ) + payload id-only | SEC-DATA-01 |

### 5.2 Security matrix — base

ส่วนนี้ต้องรันทุกครั้งที่แตะ pipeline (ชั้น L1/L2/L4 ตามคอลัมน์)

| ID | ชั้น | กรณีทดสอบ | ผลที่คาด |
| --- | --- | --- | --- |
| SEC-TEN-01 | L2 | device token ร้าน A ยิง host ร้าน B | 401 `session_invalid` |
| SEC-TEN-02 | L2 | connector token ร้าน A เรียกงานร้าน B | ไม่มีข้อมูลร้าน B หลุด |
| SEC-TEN-03 | L2 | staff token ร้าน A เปิด/ปิดบิลร้าน B | 404 |
| SEC-TEN-04 | L2 | `NODE_ENV=production` + `x-tenant-slug` ปลอม | 404 `tenant_not_found` |
| SEC-TEN-05 | L2 | `Host` แปลก/ไม่มี subdomain | 404 |
| SEC-TEN-06 | L1 | ต่อด้วย role `pos_app` โดยไม่ `set_config` | 0 แถวทุกตาราง RLS |
| SEC-TEN-07 | L1 | `pos_app` อ่าน `outbox` ข้ามร้าน | อ่านได้ (โดยตั้งใจ) แต่ payload มีแต่ id |
| SEC-AUTH-01 | L2 | ไม่มี token ทุก endpoint staff/connector | 401 |
| SEC-AUTH-02 | L2 | token สุ่มผิด 21 ครั้งใน 10 นาที | 429 จาก `staff-fail` |
| SEC-AUTH-03 | L2 | connector token เรียก `/api/staff/*` | 403 |
| SEC-AUTH-04 | L2 | staff token เรียก `/api/connector/*` | 403 |
| SEC-AUTH-05 | L2 | device token หลังปิดบิล | 401 ทันที |
| SEC-AUTH-06 | L2 | device token หลัง rotate epoch | 401 |
| SEC-AUTH-07 | L2 | device token อายุเกิน 12 ชั่วโมง | 401 |
| SEC-AUTH-08 | L2 | order token เดียว ยิงพร้อมกัน 20 คำขอ | สำเร็จ 1, ที่เหลือ 403 |
| SEC-AUTH-09 | L2 | idempotency key เดิม body ต่าง | 422 `idempotency_mismatch` |
| SEC-AUTH-10 | L2 | ปิด `staff_user.active` แล้วเรียก | 401 |
| SEC-AUTH-11 | L1/L3 | ค้น log/DB ด้วย token plaintext | ไม่พบ (มีแต่ hash) |
| SEC-ROLE-01 | L2 | kitchen เปลี่ยนราคา / manager เปลี่ยน | 403 / 200 |
| SEC-ROLE-02 | L2 | kitchen เปลี่ยนสถานะเป็น `accepted` | 403 |
| SEC-ROLE-03 | L2 | cashier เปิด/ปิด/ย้ายบิล; kitchen ทำ | 200; 403 |
| SEC-ROLE-04 | L2 | manager เท่านั้น reset/audit | 403 สำหรับ role อื่น |
| SEC-ROLE-05 | L2 | connector แจ้ง paid/cancelled ของบิลร้านอื่น | 404 |
| SEC-IN-01 | L2/L4 | body 129KB (API และ Caddy) | 413 |
| SEC-IN-02 | L2 | qty 0/21, 31 บรรทัด, รวม 61 ชิ้น | 400/422 |
| SEC-IN-03 | L2 | menuItemId ไม่มี/ปิดขาย | 409 `item_unavailable` |
| SEC-IN-04 | L2 | note 201 ตัวอักษร / newline / emoji | 422 หรือบันทึกและพิมพ์ถูกต้อง |
| SEC-IN-05 | L2 | SQLi ใน note/slug/id | ไม่ 500, ไม่รั่ว schema |
| SEC-IN-06 | L2/L4 | path `..`, `//`, `%2e%2e` | 404 |
| SEC-IN-07 | L2 | method/content-type ผิด | 4xx ไม่ใช่ 5xx |
| SEC-IN-08 | L2 | idempotency key ยาว/อักขระพิเศษ | 400 |
| SEC-IN-09 | L2 | ชื่อเมนูมี `\n` (log injection) | log เป็น JSON บรรทัดเดียว |
| SEC-AB-01 | L2 | สั่งซ้ำภายใน cooldown ด้วย key ใหม่ / key เดิม | 429 + Retry-After / ผ่าน |
| SEC-AB-02 | L2 | ออเดอร์ที่ 21 ของบิล (นับที่ยกเลิกด้วย) | 403 `order_quota_exceeded` |
| SEC-AB-03 | L2 | เครื่องที่ 13 ของบิล; สแกนซ้ำ clientId เดิม | 429 / ไม่กินที่นั่ง |
| SEC-AB-04 | L2 | invite เกิน 8 ครั้ง, เกิน 10 ครั้ง/ชม., invite ต่อทอด | 404/429/403 |
| SEC-AB-05 | L2 | QR เก่าหลังปิดบิล/rotate | 401/409 |
| SEC-AB-06 | L2 | 301 คำขอ/นาที จาก IP เดียว | 429 |
| SEC-AB-07 | L2 | SSE เกิน 20 staff / 500 guest ต่อร้าน | 429 `too_many_streams` |
| SEC-AB-08 | L3 | 2,000 ออเดอร์พร้อมกัน | 0 ซ้ำ 0 หลุด |
| SEC-EDGE-01 | L4 | HTTP → HTTPS, HSTS | redirect 308 + header |
| SEC-EDGE-02 | L4 | TLS 1.0/1.1, cipher อ่อน | ปฏิเสธ |
| SEC-EDGE-03 | L4 | CSP/nosniff/frame/referrer/Permissions | ครบตาม Caddyfile |
| SEC-EDGE-04 | L4 | `Server` header, stack trace ตอน 500 | ไม่มี |
| SEC-EDGE-05 | L4 | `/internal/*` จากภายนอก; tls-ask จาก loopback | 404; ok/no |
| SEC-EDGE-06 | L4 | CORS กับ origin แปลก | ไม่มี wildcard+credentials |
| SEC-EDGE-07 | L4 | TE/CL conflict (request smuggling) | ถูกปฏิเสธ |
| SEC-EDGE-08 | L4 | connector ต่อ TLS ที่ CA ไม่รู้จัก | ปฏิเสธ |
| SEC-EDGE-09 | L4 | connector ตั้ง `POS_URL=http://` | ต้องปฏิเสธ (ปัจจุบันส่ง — F-04) |
| SEC-DATA-01 | L1 | outbox payload มีคีย์นอก allowlist | 0 แถว |
| SEC-DATA-02 | L1 | backup/export มี token/secret | ไม่มี |
| SEC-DATA-03 | L4 | access log มี token/Authorization | ถูก redact |
| SEC-DATA-04 | L2 | error response มี SQL/stack | ไม่มี |
| SEC-DATA-05 | L0 | dependency audit/lockfile | ไม่มีช่องโหว่ high |

### 5.3 Security matrix — delivery pipeline

| ID | ชั้น | กรณีทดสอบ | ผลที่คาด |
| --- | --- | --- | --- |
| SEC-Q-01 | L2/L4 | ต่อ Redis จากนอก network โดยไม่มี password | ปฏิเสธ |
| SEC-Q-02 | L2 | `KEYS *`/`SCAN` บน Redis ระหว่างมีงาน | มีแต่ id/envelope ห้ามมีชื่อ/เบอร์/ราคา/note |
| SEC-Q-03 | L1.5 | แก้ payload ในคิว (amount/items) แล้วให้ worker ส่ง | ยอด/รายการที่ถึง POS ต้องมาจาก DB ไม่ใช่คิว |
| SEC-Q-04 | L2 | ลบ/แก้ key ในคิวระหว่างส่ง | recovery scan หยิบงานซ้ำได้ ไม่หาย |
| SEC-ACK-01 | L2 | ACK ด้วย token ร้านอื่น/ไม่มี token | 401/403 |
| SEC-ACK-02 | L2 | ACK ซ้ำ `delivery_id` เดิม 10 ครั้ง | idempotent, สถานะไม่เปลี่ยนซ้ำ |
| SEC-ACK-03 | L2 | ACK ย้อนสถานะ (acked → pending) | ปฏิเสธ |
| SEC-ACK-04 | L2 | ACK ของ order ที่ไม่ได้อยู่ในร้านนั้น | 404 |
| SEC-INBOX-01 | L1.5 | dedup key ชนกันข้ามร้าน (store A vs B) | ไม่ชน (unique ต่อ store) |
| SEC-INBOX-02 | L1.5 | สร้าง inbox row ปลอมให้ดูเหมือน ACK แล้ว | ระบบไม่ถือว่า acked ถ้าไม่มี ACK จริง |
| SEC-INBOX-03 | L2 | ลบ inbox แล้วส่งซ้ำ | FloCafe idempotency ยังกันซ้ำ (ชั้นที่สอง) |
| SEC-TRANSPORT-01 | L4 | ต่อ push endpoint โดยไม่มี auth/หมดอายุ token | 401 |
| SEC-TRANSPORT-02 | L4 | replay envelope เก่าหลัง ACK / นอกหน้าต่างเวลา | ปฏิเสธ |
| SEC-TRANSPORT-03 | L4 | TLS ที่ CA ไม่รู้จัก (ถ้าใช้ HTTPS) | ปฏิเสธ |
| SEC-STATUS-01 | L2 | ลูกค้าบิล A อ่าน delivery status บิล B | 404/ไม่พบ |
| SEC-RECOVERY-01 | L2 | recovery scan ระหว่างมี tenant อื่น | ไม่ข้าม tenant, ไม่แตะงานที่ยัง live |

### 5.4 เทคนิค

- **Negative matrix** จากตารางเดียว: ทุก endpoint × (ไม่มี token, ผิดบทบาท, ผิดร้าน, body ผิดรูป)
- **Concurrency proof**: order token/cooldown/quota/ACK ซ้ำ ต้องยิงพร้อมกัน 20–100
- **Replay/mutation**: แก้ envelope ทีละฟิลด์ (orderId, amount, storeId) แล้วยืนยันการปฏิเสธ
- **Property-based**: qty 1–20 × ราคา 0–99,999,999 เทียบสูตรอิสระ
- **Static rules**: ห้าม `sql.unsafe`, ห้าม `http://` ใน connector, ห้าม log token
- **Scan**: ZAP baseline ผ่าน Caddy, `testssl.sh`, dependency audit

## 6. แผนทดสอบประสิทธิภาพ

### 6.1 SLO

| ตัวชี้วัด | เป้า | วัดที่ |
| --- | --- | --- |
| Availability (guest API) | ≥ 99.9% / เดือน | 5xx rate ที่ edge |
| `POST /api/orders` | p95 ≤ 500 ms, p99 ≤ 1.2 s | edge |
| **Delivery lag (commit → ACK)** | p95 ≤ 5 s, p99 ≤ 10 s | `orders.created_at` → `delivery.acked_at` |
| **Recovery หลัง Redis หาย** | ≤ 60 s | เวลาจนงานถูกส่งครบ |
| **ACK → สถานะที่ลูกค้าเห็น** | ≤ 1 s | SSE latency |
| Outbox lag | p95 ≤ 30 s | `now() - outbox.created_at` ของงานค้าง |
| Recovery scan duration | p95 ≤ 2 s ที่ 1M แถว | metric ของ scan |
| ออเดอร์หาย/ซ้ำ | 0 (strict) | invariant |

### 6.2 Workload

- 1 ร้าน: 20–60 โต๊ะ, peak 1 order/s; แพลตฟอร์ม 50–200 order/s
- Burst: 300 เครื่อง/5 s ต่อร้าน, 2,000 เครื่อง/~6 s
- Delivery: 200 order/s ที่ 1/10/100 ร้าน; 1M แถวในตาราง delivery สำหรับทดสอบ scan

### 6.3 Scenarios

| ID | สถานการณ์ | โหลด | เกณฑ์ผ่าน |
| --- | --- | --- | --- |
| PERF-01 | เมนู cache hit | 200 VU, 8 s | p95 ≤ 50 ms, 0 error |
| PERF-02 | Rush 300/5s ครบวงจร | 300 guests | 300/300, order p95 ≤ 500 ms |
| PERF-03 | Rush 2,000/6s | 2,000 guests | 2,000/2,000, 0 dup |
| PERF-04 | Mixed steady 30 นาที | 70% peak | ทุก SLO |
| PERF-05 | SSE fanout | 500 guest/ร้าน × 5 | ไม่หลุด, RSS < 400 MB |
| PERF-06 | Connector drain (pull เดิม) | 200 งาน | ครบ ≤ 60 s, 0 ซ้ำ |
| PERF-07 | Delivery throughput | 200 order/s, 100 ร้าน | delivery lag p95 ≤ 5 s |
| PERF-08 | Backlog 10k | 10k งานค้าง | drain ≤ 5 นาที, 0 dup |
| PERF-09 | Recovery scan @1M rows | scan ทุก 15 s | p95 ≤ 2 s, ไม่กระทบ OLTP |
| PERF-10 | Soak | 2 ชม. 50% peak | RSS โต < 5%/ชม. |
| PERF-11 | Noisy neighbor | ร้าน A 10× | p95 ร้าน B เบี่ยง ≤ 20% |

### 6.4 Load driver

- Bun อ่าน `GUEST_QR_SECRET` + `src/crypto.ts` สร้าง table token จริง
- วัด delivery lag ต่อออเดอร์ (timestamp ใน DB) ไม่ใช่แค่ HTTP latency
- เก็บ p50/p95/p99, queue depth, ack rate, recovery time; รัน 3 ครั้งใช้ค่ามัธยฐาน

### 6.5 Metrics ที่ต้องมี (F-05)

```json
{
  "outbox_pending": 0,
  "outbox_oldest_age_seconds": 0,
  "delivery_pending": 0,
  "delivery_acked_total": 0,
  "delivery_failed_total": 0,
  "delivery_lag_p95_seconds": 0,
  "redis_queue_depth": 0,
  "recovery_scan_duration_ms": 0,
  "recovery_requeued_total": 0,
  "connector_inbox_hits_total": 0,
  "db_pool": { "size": 10, "idle": 3, "waiting": 0 },
  "process": { "rss_bytes": 0, "uptime_seconds": 0 }
}
```

endpoint ต้องเป็น `/internal/metrics` (loopback, Caddy บล็อก `/internal/*` แล้ว)

### 6.6 Capacity report

| หัวข้อ | ตัวอย่าง |
| --- | --- |
| คอขวด | Redis ops, delivery worker concurrency, FloCafe 150 req/min |
| Throughput ที่ p95 ยังอยู่ใน SLO | 150 order/s ต่อ 2 vCPU |
| ร้านต่อ node | 40 ร้าน (peak 1 order/s/ร้าน) |
| Recovery time @1M rows | 45 s |
| ข้อเสนอ | Stream + consumer group, batch ACK, per-bill partition |

## 7. Reliability & chaos

### 7.1 Failure model

| ส่วน | วิธีพัง | พฤติกรรมที่ต้องการ |
| --- | --- | --- |
| API | kill -9 กลางธุรกรรม | rollback; retry ด้วย key เดิมได้ผลเดิม |
| Postgres | restart/slow/ตัด conn | 503 เร็ว, pool ไม่หมด, ไม่ parcial |
| Dispatcher | ตายระหว่างอ่าน outbox กับ push Redis | recovery scan หยิบซ้ำ, ไม่หาย |
| Redis | restart/flush/evict/partition | งานไม่หาย (DB เป็นแหล่งจริง), ฟื้นแล้วส่งครบ |
| Delivery Worker | ตายหลัง push ก่อน ACK | ส่งซ้ำ → inbox dedup → ACK เดิม |
| Connector | ตายหลัง FloCafe สร้าง แต่ก่อน ACK | inbox replay + FloCafe idempotency → 1 ออเดอร์ |
| Transport | ตัด/หน่วง/รีเซ็ต | backoff, lease หมดแล้วส่งใหม่, ไม่ dup |
| FloCafe | 5xx/429/ค้าง | pending + retry, ไม่กลายเป็น permanent ผิด |
| Caddy | reload/restart | 0 5xx |
| host | ดิสก์เต็ม/เวลาเพี้ยน | fail closed |

### 7.2 แม่แบบ experiment

```text
สมมติฐาน: เมื่อ <fault> ระบบยัง <steady state>
ขอบเขต: <service/tenant>
ตัวชี้วัด: <SLO/invariant>
เวลากระทบ: <วินาที>
เงื่อนไข abort: error rate > 5% นาน 60 s หรือ invariant แตก
ผลลัพธ์: timeline + หลักฐาน + ข้อสรุป
```

### 7.3 Catalog

| ID | Fault | สมมติฐาน |
| --- | --- | --- |
| CHAOS-C1 | kill API ระหว่าง 200 orders | ไม่มีออเดอร์ครึ่ง ๆ |
| CHAOS-C2 | restart Postgres | ฟื้น ≤ 30 s, outbox ครบ |
| CHAOS-C3 | Postgres หน่วง 2 s | 503 ภายใน 10 s, ไม่ค้าง |
| CHAOS-C4 | kill worker กลาง batch | ไม่มีงานหาย, ซ้ำได้แต่ idempotent |
| CHAOS-C5 | kill connector หลัง POS สร้าง | lease หมด → ส่งซ้ำ → 1 ออเดอร์ |
| CHAOS-C6 | ตัดเครือข่าย connector ↔ cloud 60 s | backoff, ฟื้นแล้วครบ |
| CHAOS-C7 | ตัดเครือข่าย 5 นาที | งานรอในคิว, ฟื้นแล้วตามลำดับ |
| CHAOS-C8 | FloCafe 429 ยาว 2 นาที | connector ไม่ตาย, งานไม่ถูกทิ้ง |
| CHAOS-C9 | FloCafe 500 ยาว 10 นาที | เห็น "งานค้าง" ไม่ใช่หายเงียบ (F-02) |
| CHAOS-C10 | Caddy restart | 0 5xx |
| CHAOS-C11 | daily reset ระหว่างมีงานค้าง | ปิดบิลสม่ำเสมอ, device ตัด, epoch +1 |
| CHAOS-C12 | เวลาเครื่อง connector กระโดด ±5 นาที | ไม่ dup/หลุด |
| **CHAOS-C13** | **Redis restart 60 s (AOF on)** | **ไม่มีงานหาย; ฟื้นแล้วส่งครบ; 0 dup** |
| **CHAOS-C14** | **Redis FLUSHALL** | **recovery scan ส่งครบ ≤ 60 s; 0 dup** |
| **CHAOS-C15** | **Redis maxmemory eviction** | **เหมือน C14** |
| **CHAOS-C16** | **kill dispatcher ระหว่าง commit กับ enqueue** | **งานยังอยู่ใน outbox; scan หยิบได้** |
| **CHAOS-C17** | **ตัด ACK path 30 s** | **ส่งซ้ำ → inbox replay → ACK เดียว** |
| **CHAOS-C18** | **duplicate enqueue ×10** | **POS สร้าง 1 ออเดอร์** |
| **CHAOS-C19** | **connector 2 ตัวต่อร้านเดียว (split-brain)** | **inbox แยกกันแต่ POS idempotency กันซ้ำ** |
| **CHAOS-C20** | **recovery scan ระหว่างโหลด** | **ไม่แย่งงาน live, lag ยังอยู่ใน SLO** |
| **CHAOS-C21** | **kill delivery worker กลาง batch** | **lease หมด → ส่งใหม่ → 0 dup** |
| **CHAOS-C22** | **ACK ปลอม/ซ้ำพร้อมกัน 100** | **สถานะ monotonic, ไม่มี acked ผิด** |

### 7.4 Invariants

#### ธุรกิจ

1. 201 → `orders` 1 + `order_item` ≥ 1 + `total = Σ(unit×qty)` + `outbox` 1 + `delivery` 1
2. `pos_forward/delivery = sent/acked` → `bill.pos_order_id` ไม่ null; `pos_item_ids` ไม่ทับกันในบิล
3. บิลปิด → ไม่มี device active; epoch +1 ครั้งเดียว
4. ไม่มี `(tenant_id, idempotency_key)` ซ้ำ; ไม่มีออเดอร์ FloCafe สองใบต่อบิล

#### Delivery

1. **D-INV-1**: ทุกออเดอร์ที่ commit แล้วต้องจบที่ `acked` หรือ `failed(permanent)` ภายใน 5 นาที (หรือมี alert เมื่อ POS ล่ม) — ไม่มี `pending/queued` ค้างเงียบ
2. **D-INV-2**: จำนวนออเดอร์ FloCafe ที่สร้างต่อออเดอร์คลาวด์ = 1 (สำเร็จ) หรือ 0 (ยังไม่ส่ง)
3. **D-INV-3**: ACK ซ้ำไม่เปลี่ยน `pos_order_id` และไม่ถอยสถานะ
4. **D-INV-4**: inbox unique `(store_id, order_id)`; replay คืน ACK เดิม
5. **D-INV-5**: ค่าใน Redis มาจาก allowlist (id/envelope) ไม่มี PII/ราคา/note
6. **D-INV-6**: recovery scan หยิบเฉพาะงาน non-terminal และไม่แย่งงานที่ยัง live (lease)
7. **D-INV-7**: สถานะ delivery ที่ลูกค้าเห็น monotonic และเขียนจาก server เท่านั้น

```sql
-- งานค้างเกินเวลา (D-INV-1 / F-02)
select id, delivery_state, updated_at from pos_forward
where delivery_state in ('pending','queued') and updated_at < now() - interval '5 minutes';

-- ออเดอร์ที่ commit แล้วแต่ไม่มีแถว delivery
select o.id from orders o
left join pos_forward f on f.order_id = o.id
where f.id is null and o.created_at < now() - interval '1 minute';

-- สถานะถอยหลัง/ขัดกัน
select id from pos_forward where delivery_state = 'acked' and acked_at is null;

-- outbox ค้าง/แก่
select count(*) as pending, coalesce(max(now() - created_at), interval '0') as oldest
from outbox where processed_at is null;

-- payload นอก allowlist
select id, topic, k from outbox, jsonb_object_keys(payload) k
where k not in ('orderId','billId','tableId','epoch','action','from','to','by',
                'cancelledOrderIds','reason','movedToBillId','toTableId','toBillId','fromBillId');
```

### 7.5 Soak

- 2 ชั่วโมงที่ 50% peak; วัด RSS/fd/conn ทุก 30 s
- เกณฑ์: RSS โต < 5%/ชม., connection ไม่โต monotonic, queue depth ไม่สะสม, inbox ไม่โตเกิน retention
- nightly ใช้ 15 นาทีเวอร์ชันย่อ

### 7.6 Offline-first proof

1. kill pos-server + Redis ทั้งกอง
2. ที่ FloCafe: เปิดโต๊ะ → สั่ง → KDS → ชำระ → ปิดบิล → พิมพ์ใบเสร็จ
3. ยืนยันว่าไม่มีคำขอค้าง/บล็อก UI และยอดถูกต้อง
4. เปิดกลับ → ไม่มีออเดอร์ซ้ำ/ข้อมูลเพี้ยน; งานที่ค้างใน outbox ส่งครบ

### 7.7 Recovery objectives

| กรณี | RPO | RTO |
| --- | --- | --- |
| API ตาย | 0 | ≤ 30 s |
| Postgres restart | 0 | ≤ 60 s |
| Redis หายทั้งหมด | 0 (outbox ยังอยู่) | ≤ 60 s |
| connector ตาย | 0 | ≤ 90 s |
| FloCafe ตาย | 0 | ≤ 2 นาทีหลังฟื้น |
| ACK หลุด | 0 | ≤ 30 s (retry) |

### 7.8 Migration profile (pull + push พร้อมกัน)

- ต้องพิสูจน์ว่าเปิดสองเส้นทางแล้วไม่เกิดออเดอร์ซ้ำ: inbox/pull job เดียวกันถูก dedup ที่เดียว
- ถ้าปิด pull ระหว่างมีงานค้าง ต้องมี drain script ที่รอ `pending` = 0 ก่อนปิด
- เทส: 200 งานค้าง → เปิด push → ตรวจ 0 ซ้ำ และทุกงาน acked

## 8. Data integrity และ reconciliation

- **ฝั่งคลาวด์**: invariant §7.4 ทั้งหมด (ธุรกิจ 1–4 + D-INV-1..7)
- **ข้ามระบบ**: บิล paid → `sum(orders.total_satang)` = ยอดออเดอร์ FloCafe = Σ payments (ต่าง 0 สตางค์)
- **ปิดบิลสองทาง**: ปิดที่ FloCafe → ACK `paid`; ถ้าคลาวด์ปิดก่อน → `alreadyClosed: true` ไม่ถอยสถานะ
- **ย้าย/ยกเลิก**: `table_audit` 1 แถว + `outbox table.rotated` 1 แถว
- **ACK กับสถานะครัวแยกกัน**: ACK = "ถึงร้านแล้ว"; สถานะครัว = "กำลังทำ/พร้อม/เสิร์ฟ" — ห้ามใช้แทนกัน (F-08)

## 9. CI/CD

### 9.1 ประตูคุณภาพ

| ประตู | เมื่อไหร่ | ชุดที่รัน | งบ |
| --- | --- | --- | --- |
| PR | แตะ `pos-server/**`, `main/**`, `tests/qr-server/**` | L0 + L1 + L1.5 + L2 + security subset | ≤ 12 นาที |
| Nightly | ทุกคืน | L3 + security เต็ม + chaos-lite (C1,C4,C5,C13,C16,C17) + soak 15 นาที | ≤ 50 นาที |
| Weekly | สัปดาห์ละครั้ง | L4 + L5 ทุก scenario + chaos เต็ม + soak 2 ชม. | ≤ 7 ชม. |
| Release | ก่อนปล่อย | ทั้งหมด + upgrade migration + migration profile + soak 24 ชม. | ตามรอบ |

### 9.2 Workflow (โครง)

```yaml
qr-server:
  runs-on: ubuntu-24.04
  services:
    postgres:
      image: postgres:16
      env:
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: test-only
        POSTGRES_DB: pos
      ports: ["5432:5432"]
      options: >-
        --health-cmd "pg_isready -U postgres -d pos"
        --health-interval 2s --health-timeout 5s --health-retries 30
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: "1.4" }
    - run: npm ci
    - run: npm run build
    - name: Create pos roles and database
      run: >-
        PGPASSWORD=test-only psql -h 127.0.0.1 -U postgres
        -v migrate_pw=mig_pw -v app_pw=app_pw
        -f pos-server/deploy/db-setup.sql
    - name: pos-server deps + migrate + contract suites
      working-directory: pos-server
      env:
        ADMIN_DATABASE_URL: postgres://pos_migrate:mig_pw@127.0.0.1:5432/pos
        DATABASE_URL: postgres://pos_app:app_pw@127.0.0.1:5432/pos
      run: |
        bun install --frozen-lockfile
        bun run src/migrate.ts
        bun run test
    - name: harness (L1.5)
      run: npm run test:qr-server
    - uses: actions/upload-artifact@v4
      if: always()
      with: { name: qr-server-artifacts, path: artifacts/ }
```

### 9.3 สคริปต์

```jsonc
{
  "test:qr-server": "node tests/qr-server/suites/run.cjs all",
  "test:qr-server:contract": "node tests/qr-server/suites/run.cjs contract",
  "test:qr-server:sim": "node tests/qr-server/suites/run.cjs sim",
  "test:qr-server:api": "node tests/qr-server/suites/run.cjs api",
  "test:qr-server:e2e": "node tests/qr-server/suites/run.cjs e2e",
  "test:qr-server:integration": "node tests/qr-server/suites/run.cjs e2e",
  "test:qr-server:security": "node tests/qr-server/suites/run.cjs security",
  "test:qr-server:perf": "node tests/qr-server/suites/run.cjs perf",
  "test:qr-server:chaos": "node tests/qr-server/suites/run.cjs chaos"
}
```

> `contract` และ `sim` มีแล้วและเขียว; `e2e`/`security`/`perf`/`chaos` จะถูกเพิ่มใน Phase 1–4

### 9.4 Test selection

| ไฟล์ที่เปลี่ยน | suite |
| --- | --- |
| `src/routes/**` | L1 + L2 + security ของ route นั้น |
| `src/dispatcher.ts`, `src/delivery-worker.ts` | L1.5 + CHAOS-C13..C21 + PERF-07..09 |
| `connector/**` | L1.5 + L3 + CHAOS-C5/C6/C17/C19 |
| `migrations/**` | L1 + upgrade + reconciliation |
| `main/server-app.ts` | L3 + SEC-EDGE-04 + perf FloCafe |
| `main/routes/orders.ts` | L3 + reconciliation + idempotency |

### 9.5 Flake policy

- security: retries 0
- perf: 3 รัน ใช้ค่ามัธยฐาน ผ่อนได้ ≤ 10% พร้อมเหตุผล
- quarantine ต้องมี owner + วันหมดอายุ + issue คู่
- ห้าม `skip` ถาวรโดยไม่มีเงื่อนไขปิด

## 10. Observability

- **Correlation**: `x-request-id` (Caddy) → API log; `delivery_id` → dispatcher/worker/connector/FloCafe (`Idempotency-Key`)
- **Log fields**: `level`, `ts`, `tenant`, `orderId`, `deliveryId`, `attempt`, `state`, `ms`, `error_code`; ห้าม token/เบอร์/ชื่อ
- **Dashboard**: order/s, delivery lag p95, queue depth, ack rate, recovery time, inbox hit rate, pos_forward pending/age, FloCafe 429
- **Alert**: delivery ค้าง > 5 นาที, recovery scan > 60 s, queue depth > 10k, 5xx > 1%, connector ไม่มีรอบสำเร็จ > 5 นาที, inbox hit rate พุ่ง (สัญญาณส่งซ้ำผิดปกติ)

## 11. Roadmap

| Phase | ระยะ | สิ่งส่งมอบ | ผลลัพธ์ |
| --- | --- | --- | --- |
| 0 | 4 วัน | นิยาม envelope/state (§1.2, §1.6, §8), `delivery.ts`, compose + Redis + doubles | **เสร็จบางส่วน**: contract 28 + sim 7 checks เขียว; compose ยังไม่รัน |
| 1 | 1 สัปดาห์ | L1 + L1.5 + L2 (fake FloCafe/Redis/connector) + security TEN/AUTH/Q/ACK + PR gate | จับ regression สัญญา pipeline ก่อน merge |
| 2 | 1–2 สัปดาห์ | dispatcher + delivery worker + inbox + ACK จริง; L3 E2E + C13–C18 | พิสูจน์ no-loss/no-dup บนของจริง |
| 3 | 1 สัปดาห์ | perf rig + PERF-07..11 + capacity report | รู้คอขวดและ headroom |
| 4 | 1 สัปดาห์ | chaos เต็ม + soak + L4 (TLS/ZAP) + dashboards + runbook | พร้อมปล่อย/on-call |

รวม 5–6 สัปดาห์ (1–2 คน) — Phase 2 ต้องเริ่มหลัง F-01 แก้ ไม่งั้น E2E แดงตลอด

## 12. Definition of Done + mutation

เสร็จเมื่อ:

1. `stack.ts up` จากเครื่องเปล่า → seed → รัน suite ครบได้ ไม่มี manual step
2. P1 cases (§5.2, §6.3, §7.3) automate 100% และรันซ้ำ 10 ครั้งเขียวติด
3. **Mutation ต้องแดง**:
   - ลบ `verifyTableSig` → QR forgery test แดง
   - ลบ `set_config('app.tenant')` → SEC-TEN-01/06 แดง
   - ลบ unique idempotency / replay check → SEC-AUTH-09 / SEC-AB-08 แดง
   - ข้าม insert `outbox` → §7.4 (ธุรกิจ ข้อ 1) แดง
   - mark `sent/acked` ก่อน POS ตอบ → CHAOS-C5 / D-INV-2 แดง
   - ปิด inbox dedup → CHAOS-C18 / D-INV-2 แดง
   - ปิด recovery scan → CHAOS-C14/C16 / D-INV-1 แดง
   - ใช้ payload จากคิวแทน DB → SEC-Q-03 แดง
4. งบเวลาต่อประตูไม่เกิน (§9.1) และ artifact ครบ
5. runbook 1 หน้า: ดู log ไหน, ตรวจ invariant ไหน, escalate ใคร

## 13. ความเสี่ยงและคำถามเปิด

| # | เรื่อง | ผลกระทบ | ข้อเสนอ |
| --- | --- | --- | --- |
| 1 | มีสองเซิร์ฟเวอร์: `pos-server` (outbox) กับ `qr-ordering-server` (relay tunnel) | ออกแบบผิดตัว | ยืนยัน `pos-server` เป็นตัวจริง (ภาพ 1/2 ชี้ที่นี่) — relay อยู่ภาคผนวก B |
| 2 | **ทิศทาง transport ของ Delivery Worker → Local Connector** (WS ยาว / HTTPS + mTLS / connector pull จากคิว) | กำหนดเทส security/perf ทั้งก้อน | **ตัดสินแล้ว: WS ออกจากร้าน** (§1.6) — ถ้าเปลี่ยนภายหลัง แก้เฉพาะ transport adapter ไม่กระทบ contract |
| 3 | Redis persistence: Stream + AOF หรือ pub/sub + scan อย่างเดียว | RTO หลัง Redis หาย | แนะนำ Stream + consumer group + scan เป็น safety net |
| 4 | F-01 rate limit ของ FloCafe | E2E แดงตั้งแต่ต้น | cache JWT นอก loop + global limit เป็น env + key ตาม principal |
| 5 | F-02 งานค้างเงียบ | ออเดอร์หายโดยไม่มีใครรู้ | state `failed` + alert + dashboard |
| 6 | F-08 ไม่มีสถานะ "ถึงร้าน" | ลูกค้าไม่รู้ความจริง | state machine §8 + guest view |
| 7 | Retention ของ inbox/dedup/outbox | โตไม่จำกัด/dup หลังลบ | TTL 7–30 วัน + job vacuum + เทส retention |
| 8 | Docker ไม่ทำงานบนเครื่อง dev นี้ | รัน T1/T2 ในเครื่องไม่ได้ | CI Linux เป็นหลัก; T0 ใช้ fake-redis |
| 9 | Cloud payment/reconciliation ยังไม่มี | ขอบเขตภาพกว้างกว่าโค้ด | เทสเฉพาะ "สัญญาณชำระเงิน" จาก FloCafe |

## 14. ภาคผนวก

### A. นิยามสัญญา delivery (ร่าง)

```ts
// tests/qr-server/harness/delivery.ts
export type DeliveryState = 'pending' | 'queued' | 'delivering' | 'acked' | 'failed';

export interface DeliveryEnvelope {
  deliveryId: string;   // uuid ต่อการพยายามหนึ่งครั้ง
  storeId: string;      // tenant id
  orderId: string;      // orders.id
  billId: string;
  attempt: number;      // 1-based
  sentAt: string;       // ISO
}

export interface DeliveryAck {
  deliveryId: string;
  ok: boolean;
  posOrderId?: string;
  posItemIds?: string[];
  error?: { code: string; permanent: boolean };
  ackedAt: string;
}
```

กติกา: `deliveryId` ใหม่ทุกครั้งที่ส่งซ้ำ แต่ `orderId` เดิม → dedup ที่ `(storeId, orderId)`; ACK ต้องอ้าง `deliveryId`
ที่ยัง live และต้องตรง `orderId`

### B. ภาคผนวก: relay path (`qr-ordering-server`) — ถ้ายังใช้

`main/services/qr-relay.ts` เป็นคนละ transport (WS tunnel, ไม่มี inbound port) ถ้ายัง deploy:

| ID | กรณี | คาดหวัง |
| --- | --- | --- |
| RELAY-01 | challenge → `auth` signature `tunnel:{nonce}` | `ready` |
| RELAY-02 | signature ผิด/ไม่มี | ตัดการเชื่อมต่อ |
| RELAY-03 | replay `pair` nonce เดิม | ปฏิเสธ (ts 5 นาที, ใช้ครั้งเดียว) |
| RELAY-04 | path นอก allowlist | 404 ไม่ถึง Server App |
| RELAY-05 | body > 64KB / response > 10MB | 413 / ตัด |
| RELAY-06 | in-flight 21 | 503 |
| RELAY-07 | `client_ip` ไม่ใช่ IP | 400 |
| RELAY-08 | ไม่ได้ pong | terminate + backoff 1–60 s |
| RELAY-09 | DNS ชี้ private/loopback | ปฏิเสธ (SSRF) |
| RELAY-10 | `unknown_store` | หยุด tunnel จน pair ใหม่ |

### C. คำสั่งที่ใช้บ่อย

```bash
# T0
cd pos-server
bun run src/migrate.ts
bun run test
bun run bench

# FloCafe
npm run build
FLO_DEV_USER_DATA="$(mktemp -d)" node dev-server.js

# harness (เป้าหมาย)
npm run test:qr-server:contract
npm run test:qr-server:security
npm run test:qr-server:chaos
```

### D. Glossary

| คำ | ความหมาย |
| --- | --- |
| Envelope | ข้อความส่งงานจาก cloud → connector (id + attempt เท่านั้น) |
| Inbox | ตาราง dedup ฝั่งร้าน เก็บ `(store, order)` → ACK |
| ACK | การยืนยันว่า POS รับงานแล้ว (ไม่ใช่สถานะครัว) |
| Recovery scan | ตัวกวาดงาน non-terminal กลับเข้าคิว เมื่อ wake-up หาย |
| Lease | สิทธิ์ชั่วคราวในการถืองาน กัน worker หลายตัวแย่ง |
| At-least-once | ส่งอย่างน้อยหนึ่งครั้ง (อาจซ้ำ) — dedup ปลายทาง |
| Knee | จุดที่ throughput เพิ่มไม่ไหว แต่ latency พุ่ง |
