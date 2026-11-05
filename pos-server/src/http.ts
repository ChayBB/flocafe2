import { isIP } from "node:net";
import { config } from "./config.ts";
import { getTenantBySlug, type Tenant } from "./db.ts";
import { memLimit } from "./ratelimit.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra?: Record<string, unknown>,
  ) {
    super(code);
  }
}

/**
 * IP ลูกค้ามาจาก X-Real-IP ที่ Caddy ตั้งจาก {client_ip} (ผ่าน trusted_proxies/CF-Connecting-IP แล้ว)
 * server bind ที่ 127.0.0.1 เท่านั้น จึงไม่มีใครส่ง header นี้ตรงเข้ามาได้
 * production: ไม่มีหรือไม่ใช่ IP → ปฏิเสธ (ไม่ fallback เป็น 127.0.0.1 ที่ทำให้ทั้งร้านใช้โควตาเดียวกัน)
 */
export function clientIp(request: Request): string {
  const h = request.headers.get("x-real-ip");
  if (h && isIP(h)) return h;
  if (config.prod) throw new HttpError(400, "bad_proxy");
  return "127.0.0.1";
}

function tenantSlug(request: Request): string | null {
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0] ?? "";
  const suffix = "." + config.baseDomain;
  if (host.endsWith(suffix)) {
    const slug = host.slice(0, -suffix.length);
    return slug && !slug.includes(".") ? slug : null;
  }
  // dev เท่านั้น: ระบุร้านผ่าน header
  if (!config.prod) return request.headers.get("x-tenant-slug");
  return null;
}

export async function reqCtx(request: Request): Promise<{ ip: string; tenant: Tenant }> {
  const ip = clientIp(request);
  if (!memLimit(`ip:${ip}`, config.limits.ipPerMin, 60_000)) throw new HttpError(429, "rate_limited");
  const slug = tenantSlug(request);
  const tenant = slug ? await getTenantBySlug(slug) : null;
  if (!tenant) throw new HttpError(404, "tenant_not_found");
  return { ip, tenant };
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}
