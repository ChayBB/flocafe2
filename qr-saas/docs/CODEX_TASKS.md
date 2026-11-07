# Codex implementation backlog

## P0: Production blockers (complete before live orders)
1. Inspect the exact FloCafe version/repository and implement its real menu read and order write APIs in an isolated adapter. Add local durable inbox with unique cloud event IDs; only ACK after POS persistence.
2. Replace shared bootstrap admin/connector secrets with per-tenant/branch RBAC, short-lived credentials, revocation, and audit trails. Never expose bootstrap endpoints publicly.
3. Implement PostgreSQL RLS policies with transaction-local tenant context and comprehensive cross-tenant integration tests.
4. Implement secure static QR session activation: staff-controlled table opening, anti-photo replay controls, token rotation/revocation, session limits, and cleanup.
5. Implement payment state machine, amount validation, cash shift reconciliation, refunds, and real PromptPay PSP integration with signature verification, replay defense, provider reconciliation, and webhooks. Do not confirm from client claims.
6. Implement order status transitions, KDS sync, receipt/print handling, and order cancel/reprint idempotency.
7. Fix any failed tests and build issues, pin dependency lockfile and Docker image digests, set resource limits, non-root permissions, backups and restore drills.
8. Add production rate limits (per IP/table/tenant), validation and abuse filtering for notes, CORS allowlist, auth monitoring, CSP for any UI, and log redaction.
9. Add metrics, tracing, structured logs, alerting, load tests and chaos tests (DB restart, Redis restart, connector offline, duplicate ACK, network partition).
10. Add migrations and deploy rollback strategy, secret rotation and tenant provisioning CLI.

## P1
- Tenant dashboard, staff login, menu modifier groups, tax/service charges, stock and unavailable items.
- SSE/WebSocket order updates, store open/close, outbox retries and dead-letter review.
- Integration test suite with disposable Postgres/Redis and seeded two-tenant fixtures.

## Definition of done
- No cross-tenant reads/writes; no duplicated business orders or duplicate POS delivery side effects.
- Payment never becomes confirmed without authorized cash staff or verified provider event.
- Acknowledged orders survive VPS reboot and network partitions; recovery verified by tests.
- k6 scenario 50 users x 2 orders over 5 min, measured API p95 and reconciliation.
