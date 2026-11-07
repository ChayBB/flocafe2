# QR SaaS — Debian 13 / Elysia / Bun / Caddy / PostgreSQL / Redis

**Status: deployable engineering scaffold, NOT certified production-ready.** The core API, schema, outbox worker and connector polling are implemented; FloCafe adapter, real PromptPay verification, tenant-scoped RBAC and RLS are deliberately unfinished. See `docs/CODEX_TASKS.md` before live use.

## Quick start
1. Install Docker Compose on Debian 13: `sudo bash scripts/deploy-debian13.sh` (review firewall/SSH first).
2. `cp .env.example .env`; set `DOMAIN` with DNS A/AAAA pointing to VPS, unique long random `ADMIN_BOOTSTRAP_TOKEN`, `CONNECTOR_TOKEN`, and independent strong DB/Redis passwords. Quote/URL-encode passwords as needed in connection URLs.
3. `docker compose build && docker compose up -d postgres redis`
4. `docker compose run --rm api bun run scripts/migrate.ts`
5. `docker compose up -d`; inspect `docker compose logs --tail=100`.
6. `curl https://YOUR_DOMAIN/health/ready`.
7. Run Local Connector on the restaurant network only **after** implementing verified FloCafe adapter. Do not use the demo shared connector token across stores.

## Notes
- No card data is processed or stored. PromptPay integration is a Codex P0 task, not a working payment gateway.
- Cash confirmation route is a bootstrap example only; replace with authenticated branch-scoped staff permissions before launch.
- Table session issuance is admin-only scaffolding; do not expose a permanent QR session token as a static QR.
- `outbox_events` are durably handed off to `connector_deliveries`; Redis Pub/Sub is only an optimization.
- Never expose PostgreSQL or Redis ports to the Internet.
- Backups: `bash scripts/backup.sh`, encrypt and send offsite, test restore. Local backups alone are insufficient.
- For multi-branch operation replace single connector token/branch environment variables with branch-scoped credential records.
- Pin dependency versions/digests and generate/commit `bun.lock` in CI before production deployment.
