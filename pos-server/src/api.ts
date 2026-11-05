import { Elysia } from "elysia";
import { config } from "./config.ts";
import { sql } from "./db.ts";
import { getTenantBySlug } from "./db.ts";
import { HttpError } from "./http.ts";
import { guest } from "./routes/guest.ts";
import { staff } from "./routes/staff.ts";
import { connector } from "./routes/connector.ts";
import { startHub } from "./events.ts";
import { cleanupRateLimit } from "./ratelimit.ts";

export const app = new Elysia({
  serve: { idleTimeout: 120, maxRequestBodySize: config.limits.maxBodyBytes },
})
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      const retry = error.extra?.retryAfterSec;
      if (typeof retry === "number") set.headers["retry-after"] = String(retry);
      return { error: error.code, ...error.extra };
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return { error: "validation" };
    }
    if (code === "PARSE") {
      set.status = 400;
      return { error: "bad_request" };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "not_found" };
    }
    console.error(JSON.stringify({ level: "error", msg: String((error as Error)?.message ?? error) }));
    set.status = 500;
    return { error: "internal" };
  })
  .onAfterHandle({ as: "global" }, ({ set }) => {
    if (!set.headers["cache-control"]) set.headers["cache-control"] = "no-store";
  })
  .get("/healthz", async () => {
    await sql`select 1`;
    return { ok: true };
  })
  // Caddy on-demand TLS: ออกใบรับรองเฉพาะ subdomain ของร้านที่มีจริง (ไม่เปิดสู่สาธารณะ — Caddy ไม่ proxy /internal)
  .get("/internal/tls-ask", async ({ query, set }) => {
    const domain = String(query.domain ?? "").toLowerCase();
    const suffix = "." + config.baseDomain;
    const slug = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : "";
    if (slug && !slug.includes(".") && (await getTenantBySlug(slug))) return "ok";
    set.status = 404;
    return "no";
  })
  .use(guest)
  .use(staff)
  .use(connector);

if (import.meta.main) {
  await startHub();
  app.listen({ hostname: config.host, port: config.port });
  setInterval(() => cleanupRateLimit().catch(() => {}), 10 * 60_000).unref();
  console.log(JSON.stringify({ level: "info", msg: "listening", host: config.host, port: config.port }));

  const shutdown = async () => {
    await app.stop();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
