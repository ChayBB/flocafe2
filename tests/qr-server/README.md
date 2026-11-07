# QR-server test harness

Test system for the FloCafe2 ↔ QR server delivery path (`pos-server` + `connector` + FloCafe Server App).
The full design is in [`../../pos-server/TEST-SYSTEM.md`](../../pos-server/TEST-SYSTEM.md); this folder is
the executable part.

## Status

| Suite            | What it proves                                                                                                  | Runtime         | Status                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------- |
| `contract`       | envelope/ack shape, state machine, dedup key, recovery predicate, wake-queue semantics                          | Node, no Docker | green (28 checks)                |
| `sim`            | WebSocket delivery: auth handshake, duplicate delivery, lost ack replay, restart dedup, stale/foreign envelopes | Node, no Docker | green (7 checks)                 |
| `api`            | order commit, idempotency, ack + spoof, ack failure/lease, per-bill order, outbox drain, RLS, body limit        | Postgres + API  | green (18 checks)                |
| `e2e`            | guest order → connector → real FloCafe → bill → payment → cloud bill closed                                     | Node + Postgres | green (delivery + payment close) |
| `security`       | tenant isolation, ACK spoof, queue tampering                                                                    | Docker          | planned                          |
| `perf` / `chaos` | delivery lag, Redis loss, recovery scan                                                                         | Docker          | planned                          |

## Run

```bash
npm run test:qr-server        # contract + sim (no Docker)
npm run test:qr-server:api    # needs the env below and a running API
npm run test:qr-server:e2e    # starts FloCafe + API + connector itself (needs dist/)
```

The API suite needs a migrated database, the QR secret the API runs with, and a reachable server:

```bash
export ADMIN_DATABASE_URL=postgres://pos_migrate:mig_pw@127.0.0.1:5432/pos
export DATABASE_URL=postgres://pos_app:app_pw@127.0.0.1:5432/pos
export GUEST_QR_SECRET=0123456789abcdef0123456789abcdef
export POS_API_URL=http://127.0.0.1:3311
npm run test:qr-server:api
```

The runner exits 2 (not a silent skip) when the database, the secret or the API is missing.

The runner resolves `ts-node` from the repo root; nothing is installed globally.

## Layout

```text
harness/
  delivery.ts        # contract: types, validators, state machine, dedup key, recovery predicate
  db.ts              # admin/app Postgres clients + table-token helper
  fake-cloud.ts      # authenticated WS server that sends envelopes and collects acks
  fake-connector.ts  # WS client with inbox/dedup and a "drop one ack" knob
  fake-redis.ts      # wake-up queue with leases; duplicates are allowed on purpose
suites/
  run.cjs            # dependency-free runner
  contract/          # pure contract checks
  sim/               # in-process WS simulation
  api/               # Postgres + Bun API integration
  e2e/               # connector + real FloCafe (spawns its own stack)
  api/               # Postgres + Bun API integration
compose/             # Postgres + Redis + API + Caddy (+ FloCafe for L3)
```

## Contract in one screen

- Release trigger: `POST /api/orders` commits `orders` + `order_item` + `outbox` + delivery row in one
  transaction, then answers `201`. Delivery never blocks the order.
- Redis carries **wake-ups only**: `qr:wake:<storeId>` with `{ deliveryId }`.
- The worker re-reads Postgres and sends an envelope containing `deliveryId`, `storeId`, `orderId`,
  `billId`, `attempt`, `issuedAt`, `deadlineAt` and a payload snapshot (table mapping, items, known POS ids).
- The connector dedups on `(storeId, orderId)` and replays the stored ack for a duplicate delivery.
- Ack states advance `pending → queued → delivering → acked | failed`; only forward, `acked` is terminal.
- `needsRecovery()` is the only path that re-queues stale rows or expired leases.

## Compose

```bash
cd tests/qr-server/compose
docker compose -f docker-compose.test.yml up -d postgres redis migrate api1 api2
docker compose -f docker-compose.test.yml --profile e2e up -d      # + FloCafe + connector
docker compose -f docker-compose.test.yml --profile pipeline up -d # target dispatcher/worker (Phase 2)
```

Compose parses (`docker compose config`), but has not been brought up: the Docker daemon was unavailable
in the design workspace, and the `pipeline` profile points at files Phase 2 adds.

## Next

1. `e2e` expansion: append-to-existing-order, kitchen status back to the guest, cancel/merge cases.
2. `chaos`: Redis restart/flush, dispatcher crash between commit and enqueue, lost ack.
3. Wire `api` + `e2e` into the harness CI job (Postgres service, built dist, bun).
