# POS-Server — QR Ordering (Bun + Elysia + Caddy + PostgreSQL)

Multi-tenant (`<slug>.BASE_DOMAIN`) · ลูกค้าสแกน QR โต๊ะ → สั่งอาหาร → ครัว/พนักงานรับผ่าน API + SSE
ไม่มี HAProxy/Nginx: Caddy ทำ TLS, static, reverse proxy และ balance ระหว่าง Bun 2 process

```
ลูกค้า 5G ─► (Cloudflare) ─► Caddy :443 ─┬─ /api/*  ─► Bun/Elysia 127.0.0.1:3001, :3002 ─► PostgreSQL (localhost)
                                         └─ ไฟล์เว็บ ─► /opt/pos/web           pos-worker (outbox → adapters)
```

## ติดตั้ง (Debian 13)

```bash
BASE_DOMAIN=order.example.com ACME_EMAIL=you@example.com bash deploy/setup.sh
pos-admin create-tenant demo "Demo Restaurant"
pos-admin add-table demo A1          # ได้ URL → พิมพ์เป็น QR
pos-admin add-menu demo "ข้าวผัด" 60
pos-admin add-staff demo cashier1 manager   # token แสดงครั้งเดียว
```

DNS: wildcard `*.BASE_DOMAIN` ชี้เครื่องนี้ · Caddy ออกใบรับรองต่อร้านเองเมื่อมีคนเข้า (on-demand + `/internal/tls-ask` ตรวจกับตาราง tenant)
อัปเดตโค้ด: `deploy/rolling-restart.sh` (ทีละ instance ไม่มี downtime; migration ต้อง backward-compatible)

## ปัญหาในรีวิว FloCafe ที่แก้ไว้แล้ว

| ข้อ | ปัญหาเดิม | ที่นี่ |
|---|---|---|
| 1 | rate limit พังเมื่อไม่มี client IP | Caddy ตั้ง `X-Real-IP` จาก `{client_ip}` เสมอ (เชื่อ `CF-Connecting-IP` เฉพาะจาก IP ของ Cloudflare) · production ไม่มี header → 400 |
| 2 | บิลซ้ำเมื่อสั่งพร้อมกัน | `unique index one_open_bill (table_id) where status='open'` + `insert … on conflict do nothing` (ทดสอบ 10 ออเดอร์พร้อมกัน → 1 บิล) |
| 3 | QR ถาวร ใครถ่ายไปก็สั่งได้ | ต้องให้ **พนักงานเปิดโต๊ะก่อน** ลูกค้าถึงสแกน QR เข้าได้ (ไม่มี PIN) + device token ที่ตัดได้ทันที · cooldown 15 วิ/เครื่อง · โควตา 20 ออเดอร์/บิล · จำกัด 60 ชิ้น/ออเดอร์ · `require_confirm` · `rotate-qr` |
| 4 | tunnel เป็นคอขวด | ไม่มี tunnel · static ไม่ผ่านแอป · เมนู cache 30 วินาที (ล้างด้วย NOTIFY) |
| 5 | secret ใน DB | secret อยู่ใน `/etc/pos/env` (640) เท่านั้น · credential migrate แยกไฟล์ root-only |
| 6 | timeout ไม่ตรง → สั่งซ้ำ | `Idempotency-Key` บังคับ (ไม่มี → 400) · key เดิม + body เดิม → ออเดอร์เดิม, body ต่าง → 422 |
| กลาง | JSON 50MB | 128KB ทั้งที่ Caddy และ Bun · `qty` เป็นจำนวนเต็ม 1–20 · `Referrer-Policy: no-referrer` · log ซ่อน token |

## Session / เปิดโต๊ะ / Tablemate (Phase 4–6)

**บิล = session** ของโต๊ะ (หนึ่งโต๊ะมีบิลเปิดได้ครั้งละหนึ่งใบ)

1. พนักงานกด *เปิดโต๊ะ* → `POST /api/staff/tables/:id/open` (สร้างบิล/session) · โต๊ะที่ยังไม่เปิด สแกน QR ได้ 409 `table_not_open`
2. ลูกค้าสแกน QR โต๊ะ → `POST /api/session {token}` ได้ **device token** (`d_…`, เก็บ hash ใน `guest_device`) ใช้เป็น `Authorization: Bearer`
   - ร้านที่ตั้ง `require_open=false` สแกน QR แล้วระบบเปิดบิลให้อัตโนมัติ
3. **ชวนเพื่อน**: เครื่องที่เข้าด้วย QR โต๊ะกด `POST /api/session/invite` → QR ชั่วคราว 5 นาที (ใช้ได้ ≤ 8 ครั้ง, ชวนได้ ≤ 10 ครั้ง/ชม./บิล) · เพื่อนสแกน `/j/<code>` → `POST /api/session/join {code}` เข้ากลุ่มทันที ได้ device token ใหม่ (เครื่องที่เข้าทาง invite ชวนต่อไม่ได้)
4. **ป้องกันป่วน**: ออเดอร์จาก device เดียวต้องห่าง ≥ 15 วินาที (429 `order_cooldown` + `Retry-After`; retry ด้วย Idempotency-Key เดิมไม่โดน) · ≤ 20 ออเดอร์/บิล (403 `order_quota_exceeded`, ออเดอร์ที่ยกเลิกยังนับ) · ≤ 12 device/บิล

**พนักงาน** (`cashier`/`manager`):

| Endpoint | ทำอะไร |
|---|---|
| `POST /api/staff/bills/:id/close {force?}` | ปิดบิลหลังชำระ → `closed(paid)` ตัดทุก device และ SSE ทันที (มีออเดอร์ค้างต้อง `force`) |
| `POST /api/staff/bills/:id/move {toTableId}` | ย้ายโต๊ะ: บิลเก่า `closed(moved)` เปิดบิลใหม่ที่โต๊ะปลายทาง ออเดอร์ย้ายตาม (โต๊ะปลายทางไม่ว่าง → 409) |
| `POST /api/staff/bills/:id/cancel {reopen?, reason?}` | ยกเลิกออเดอร์ที่ยังไม่เสิร์ฟ ปิดบิล (`cancelled`) ตัดทุก device · `reopen` เปิดบิลใหม่ที่โต๊ะเดิม |
| `POST /api/staff/reset` (manager) | Daily Reset ทันที |

**จำเครื่อง / order token (เลือกเปิดต่อร้าน)**
- `require_open=false`: ไม่ต้องให้พนักงานเปิดโต๊ะ สแกน QR แล้วระบบเปิดบิลให้เอง (บิลเดียวต่อโต๊ะ, สแกนพร้อมกันได้บิลเดียว)
- หน้าเว็บเก็บ device token ใน `localStorage` (ปิดแท็บ/เน็ตหลุดแล้วกลับมาต่อได้) และส่ง `clientId` สุ่มประจำเครื่อง → สแกนซ้ำจากเครื่องเดิมได้ token ใหม่ ตัวเก่าถูกตัด ไม่กินจำนวนเครื่องของบิล
- `order_token=true`: ก่อนส่งออเดอร์ต้อง `POST /api/orders/token` ได้ `o_…` (10 นาที ผูกกับเครื่อง) แล้วส่งใน header `X-Order-Token` — ใช้ครั้งเดียว (atomic) ถ้าออเดอร์ล้มทั้งก้อน token ไม่ถูกใช้ · retry ด้วย Idempotency-Key เดิมคืนผลเดิมโดยไม่ต้องใช้ token · ทุกออเดอร์บันทึก `device_id`

**หมุนรหัสโต๊ะ (epoch)**: QR ที่พิมพ์ติดโต๊ะคงที่ แต่ทุกโต๊ะมี `epoch` ที่ +1 เมื่อเช็คบิล/ย้าย/ยกเลิก/Daily Reset (ในทรานแซกชันเดียวกับการปิดบิล) device token ผูกกับ epoch ที่ออก → epoch เปลี่ยนแล้วใช้ไม่ได้ · `POST /api/staff/bills/:id/rotate {reason?}` หมุนเองโดยไม่ปิดบิล (ตัดทุกเครื่องของบิลนั้น ลูกค้าตัวจริงสแกนเข้าใหม่) · `GET /api/staff/tables/:id/audit` (manager) ดูประวัติ · ทุกครั้งส่ง outbox `table.rotated {tableId, epoch}` ให้ระบบอื่น sync

**Daily Reset อัตโนมัติ**: worker ตรวจทุก 30 วินาที ปิดทุกบิลที่เปิดค้าง (`closed(daily_reset)`) + ยกเลิกออเดอร์ที่ยังไม่เสิร์ฟ ตามเวลาและ timezone ของแต่ละร้าน (ค่าเริ่มต้น 07:00 `Asia/Bangkok`) · จองรอบแบบ atomic ไม่ซ้ำแม้มีหลาย worker · ถ้า worker ดับจนเลยเวลาเกิน 30 นาที จะข้ามรอบของวันนั้น (ไม่ตัดลูกค้าที่กำลังกินข้าว)

```bash
pos-admin set-reset demo 07:00 Asia/Bangkok     # หรือ off
pos-admin set-setting demo require_confirm true
pos-admin set-setting demo confirm_first_only true   # พนักงานอนุมัติเฉพาะออเดอร์แรกของบิล แล้วสั่งเพิ่มได้เอง
pos-admin set-setting demo order_cooldown_sec 15
pos-admin set-setting demo max_orders_per_bill 20
pos-admin set-setting demo require_open false
```

## เชื่อม FloCafe POS (connector)

ออเดอร์ลูกค้า → FloCafe → KDS ของ FloCafe; ชำระเงินใน FloCafe → ปิดบิลฝั่งนี้อัตโนมัติ (ตัดทุกเครื่อง + หมุนรหัสโต๊ะ)

```
ลูกค้า → POS-Server (คลาวด์) ◄── HTTPS ขาออก ── connector (เครื่องในร้าน) ──► FloCafe Server App :3003
```

Connector **ดึงงานออกมาเอง** (pull) จึงไม่ต้องเปิดพอร์ตเข้าร้านและไม่ต้องใช้ WireGuard · token ของ connector ใช้ได้เฉพาะ `/api/connector/*`

```bash
# ฝั่งเซิร์ฟเวอร์
pos-admin set-setting demo pos_forward true
pos-admin add-staff demo flo-connector connector        # token แสดงครั้งเดียว
pos-admin set-pos-map demo table A5 8                   # โต๊ะ A5 = table id 8 ใน FloCafe
pos-admin set-pos-map demo menu "ข้าวผัด" 12             # เมนู = product id 12 ใน FloCafe

# ฝั่งร้าน (เครื่องที่เข้าถึง FloCafe ได้) — ต้องมีบัญชี FloCafe บทบาท server/manager
POS_URL=https://demo.order.example.com POS_TOKEN=... \
FLO_URL=http://127.0.0.1:3003 FLO_EMAIL=server@shop FLO_PASSWORD=... bun run connector
```

- ออเดอร์แรกของบิล → `POST /api/orders` (`dine_in` + `table_id`) แล้วเก็บ id; ออเดอร์ถัดไป → `POST /api/orders/:id/items` (ส่งทีละรายการตามลำดับต่อบิล) · ใช้ `Idempotency-Key` = id ออเดอร์ ส่งซ้ำไม่เกิดออเดอร์ซ้ำ
- โต๊ะ/เมนูที่ยังไม่ผูก id → งานล้มเหลวถาวรพร้อมเหตุผล (`pos_forward.last_error`); FloCafe ล่ม/5xx → ลองใหม่แบบ backoff
- **ต้องยืนยันกับ FloCafe เครื่องจริง:** รูปแบบตรวจ "ชำระแล้ว" (`isPaid` ใน `connector/flocafe.ts` อ่าน `bill_payment_status`/`bills[]` จากรายการออเดอร์) — เทสต์ใช้ FloCafe จำลองตามเอกสาร API

## ความปลอดภัยที่ใช้

- **RLS** ทุกตารางที่มี `tenant_id`; แอปใช้ role `pos_app` (ไม่ใช่เจ้าของตาราง/ไม่ใช่ superuser) และทุกคำสั่งอยู่ใน `withTenant()` ที่ตั้ง `app.tenant`
- composite FK `(id, tenant_id)` กันอ้างข้อมูลข้ามร้านแม้ RLS พลาด
- ราคาคำนวณจาก DB เสมอ · staff token เก็บเป็น sha256 · QR ใช้ HMAC + `timingSafeEqual` · device token/invite เก็บเฉพาะ sha256
- systemd hardening, bind `127.0.0.1`, ufw เปิดเฉพาะ 22/80/443, Postgres listen localhost
- ไม่มี secret/ข้อมูลลูกค้าใน outbox (เก็บ id อ้างอิง)

## ทดสอบ

```bash
bun run typecheck
bun run test            # smoke 136 เคส + connector 24 เคส ต้องมี DB (ดู .env.example)
BENCH_URLS=http://127.0.0.1:3001,http://127.0.0.1:3002 bun run bench
```

### ผล load test (ที่วัดจริง)

เครื่อง **2 vCPU / 8GB ใช้ร่วมกันทั้ง client, Bun ×2 และ Postgres 16** ตัวเลขจึงเป็นค่าต่ำสุดโดยประมาณ (VPS จริงไม่มี client แย่งทรัพยากร)

| สถานการณ์ | ผล |
|---|---|
| `GET /api/menu` (cache) ที่ concurrency 200 | ~19,000–23,000 req/s · p95 15–21 ms · 0 error |
| ลูกค้า 300 คนสแกนภายใน 5 วินาที (session → เมนู → สั่ง → poll×3) | 300/300 ออเดอร์ · 0 error · สั่ง p95 9 ms |
| ลูกค้า 2,000 คนสแกนภายใน ~6 วินาที (~330 ออเดอร์/วินาที + ~1,000 poll/วินาที) | 2,000/2,000 ออเดอร์ (2,000 บิล) · 0 error · สั่ง p50 119 ms / p95 470 ms |
| worker drain outbox | 2,332 งานในไม่ถึง 6 วินาที |

ยังไม่ได้วัด: เครือข่ายจริงจากมือถือ 5G, Cloudflare, จำนวน SSE ค้างนาน, ความหน่วงข้าม region

## ยังไม่ได้ทำ (ตั้งใจเว้นไว้)

- **ชำระเงิน** (SCB/KBank callback ตามที่คุยกัน) — ต่อที่ outbox/`bill.closed` และตาราง payment แยก
- **Adapter จริง**: `src/adapters/index.ts` เป็น stub แบบ log — ใส่ ERPNext / FloCafe / เครื่องพิมพ์ครัว
- **หน้า KDS/พนักงาน** — API + SSE พร้อม (`/api/staff/*`; ใช้ `fetch` stream พร้อม header เพราะ `EventSource` ใส่ Authorization ไม่ได้)
- หน้าเว็บลูกค้าใน `web/` เป็นตัวอย่างขั้นต่ำสำหรับทดสอบ flow ไม่ใช่งานออกแบบ
- ตัวเลือกเมนูเสริม (add-on), ภาษี/ค่าบริการ, ส่วนลด
- Rate limit ต่อ IP (300/นาที) เป็นแบบหลวมเพราะลูกค้าอาจใช้ wifi ร้านร่วมกัน ตัวหลักคือ limit ต่อโต๊ะ

## ข้อควรระวังตอน deploy

- Caddy ต้อง ≥ 2.7 (ใช้ `{client_ip}`, `client_ip_headers`) — `setup.sh` ติดตั้งจาก repo ทางการ; ไฟล์ Caddyfile ผ่าน `caddy validate` กับ v2.10 แล้ว และทดสอบหน้าแอปจริงแล้ว แต่ **`setup.sh`/systemd unit/การออกใบรับรองจริงยังไม่ได้รันบน Debian 13 จริง** (ตรวจแค่ `bash -n`) ให้ลองบนเครื่องทดสอบก่อน
- ปิด `PermitRootLogin`/ใช้ SSH key ก่อนเปิด ufw · ส่งไฟล์สำรองออกนอกเครื่อง · ทดสอบ restore
