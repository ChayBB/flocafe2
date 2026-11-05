import { sql } from "./db.ts";
import { adapters, type OutboxJob } from "./adapters/index.ts";
import { cleanupRateLimit } from "./ratelimit.ts";
import { runDueResets } from "./reset.ts";

const MAX_ATTEMPTS = 8;
const BATCH = 20;

/** อ่าน outbox ด้วย FOR UPDATE SKIP LOCKED — รันหลาย worker พร้อมกันได้ */
export async function tick(): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      select id, tenant_id, topic, payload, attempts from outbox
      where processed_at is null and next_attempt_at <= now()
      order by id limit ${BATCH} for update skip locked`;
    for (const r of rows) {
      const job: OutboxJob = { id: r.id, tenantId: r.tenant_id, topic: r.topic, payload: r.payload };
      const targets = adapters.filter((a) => a.topics.includes(job.topic));
      try {
        for (const a of targets) await a.handle(job);
        await tx`update outbox set processed_at = now() where id = ${r.id}`;
      } catch (e) {
        const attempts = r.attempts + 1;
        const delaySec = Math.min(3600, 2 ** attempts * 5); // exponential backoff
        console.error(JSON.stringify({ level: "error", msg: "outbox job failed", id: r.id, attempts, err: String(e) }));
        if (attempts >= MAX_ATTEMPTS) console.error(JSON.stringify({ level: "alert", msg: "outbox job dead", id: r.id, topic: r.topic }));
        await tx`
          update outbox set attempts = ${attempts}, last_error = ${String(e).slice(0, 500)},
            next_attempt_at = now() + make_interval(secs => ${attempts >= MAX_ATTEMPTS ? 86400 : delaySec})
          where id = ${r.id}`;
      }
    }
    return rows.length;
  }) as Promise<number>;
}

if (import.meta.main) {
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  let last = 0;
  let lastReset = 0;
  while (!stop) {
    const n = await tick().catch((e) => (console.error(String(e)), 0));
    if (Date.now() - last > 10 * 60_000) {
      last = Date.now();
      await cleanupRateLimit().catch(() => {});
    }
    if (Date.now() - lastReset > 30_000) {
      lastReset = Date.now();
      const rs = await runDueResets().catch((e) => (console.error(String(e)), []));
      for (const r of rs) console.log(JSON.stringify({ level: "info", msg: "daily reset", ...r }));
    }
    if (n === 0) await Bun.sleep(1000);
  }
  await sql.end({ timeout: 5 });
}
