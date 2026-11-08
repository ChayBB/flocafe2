// Connector ในร้าน: ดึงงานจาก POS-Server (HTTPS ขาออกอย่างเดียว) แล้วส่งเข้า FloCafe (Server App :3003 ในเครื่อง/LAN)
// ไม่ต้องเปิดพอร์ตเข้าร้าน ไม่ต้องใช้ WireGuard (ถ้ายังต้องการ ใช้ได้เฉพาะเส้นทางไป FloCafe)
//
//   POS_URL=https://demo.order.example.com POS_TOKEN=<connector token> \
//   FLO_URL=http://127.0.0.1:3003 FLO_EMAIL=server@shop FLO_PASSWORD=... bun run connector/flocafe.ts
//
// FloCafe: ใช้บัญชีบทบาท server (สิทธิ์ server-app.use) — ใช้ POST /api/orders, POST /api/orders/:id/items, GET /api/orders/:id
export interface Cfg {
  posUrl: string;
  posToken: string;
  posDevSlug?: string; // dev เท่านั้น: ส่ง x-tenant-slug แทน subdomain
  floUrl: string;
  floEmail: string;
  floPassword: string;
}

const num = (v: string) => (/^[0-9]+$/.test(v) ? Number(v) : v);

class Http {
  jwt: string | null = null;
  retryAfterMs = 0;
  constructor(private cfg: Cfg) {}
  private noteRetry(response: Response): void {
    const seconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0) this.retryAfterMs = Math.min(60_000, seconds * 1000);
  }
  async pos(method: string, path: string, body?: unknown) {
    const h: Record<string, string> = { authorization: `Bearer ${this.cfg.posToken}` };
    if (this.cfg.posDevSlug) h["x-tenant-slug"] = this.cfg.posDevSlug;
    if (body !== undefined) h["content-type"] = "application/json";
    const r = await fetch(this.cfg.posUrl + "/api/connector" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`pos ${method} ${path} -> ${r.status}`);
    return (await r.json()) as any;
  }
  async login() {
    const r = await fetch(this.cfg.floUrl + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.cfg.floEmail, password: this.cfg.floPassword }),
    });
    if (!r.ok) {
      this.noteRetry(r);
      throw new Error(`flocafe login -> ${r.status}`);
    }
    this.jwt = ((await r.json()) as any).access_token;
  }
  async flo(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.jwt) await this.login();
      const h: Record<string, string> = { authorization: `Bearer ${this.jwt}`, ...extra };
      if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(this.cfg.floUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 401 && attempt === 0) { this.jwt = null; continue; } // token หมดอายุ → login ใหม่ครั้งเดียว
      if (r.status === 429) this.noteRetry(r);
      return { status: r.status, json: await r.json().catch(() => null) };
    }
    throw new Error("unreachable");
  }
}

/**
 * One client per connector process: the JWT and the Retry-After cooldown must survive across poll
 * cycles, otherwise every 1.5 s cycle logs in again and trips FloCafe's login limiter.
 */
let sharedClient: { key: string; http: Http } | null = null;

function clientFor(cfg: Cfg): Http {
  const key = [cfg.posUrl, cfg.posToken, cfg.posDevSlug ?? "", cfg.floUrl, cfg.floEmail, cfg.floPassword].join("\u0000");
  if (!sharedClient || sharedClient.key !== key) sharedClient = { key, http: new Http(cfg) };
  return sharedClient.http;
}

const TERMINAL_ITEM = new Set(["cancelled", "voided", "void_adjustment", "refunded"]);
const RANK: Record<string, number> = { pending_confirm: 0, accepted: 1, preparing: 2, ready: 3, served: 4 };

/** ชำระเงินแล้วหรือไม่ — FloCafe แนบ bills[] มากับออเดอร์ทุกใบ */
export function isPaid(o: any): boolean {
  if (o?.bill_payment_status === "paid") return true;
  return Array.isArray(o?.bills) && o.bills.length > 0 && o.bills.every((b: any) => b.payment_status === "paid");
}

/** สถานะฝั่งลูกค้าของออเดอร์ QR หนึ่งใบ จากรายการใน FloCafe ที่ออเดอร์นั้นสร้าง:
 *  เริ่มทำสักรายการ = preparing · พร้อม/เสิร์ฟ ต้องครบทุกรายการ · ยกเลิกหมด = cancelled */
export function guestStatus(floItems: any[], posItemIds: string[]): string | null {
  const ids = new Set(posItemIds.map(String));
  const mine = floItems.filter((i) => ids.has(String(i.id)));
  if (!mine.length) return null;
  const live = mine.filter((i) => !TERMINAL_ITEM.has(i.status));
  if (!live.length) return "cancelled";
  const rank = (s: string) => (s === "served" || s === "completed" ? 4 : s === "ready" ? 3 : s === "preparing" ? 2 : 1);
  const ranks = live.map((i) => rank(i.status));
  const slowest = Math.min(...ranks);
  if (slowest >= 3) return slowest === 4 ? "served" : "ready";
  return Math.max(...ranks) >= 2 ? "preparing" : "accepted";
}

/** รายการใน FloCafe ที่งานนี้เพิ่งสร้าง: ยังไม่เป็นของบิลนี้ และเป็นสินค้าที่สั่งมา */
export function newItemIds(floItems: any[], knownIds: string[], productIds: string[]): string[] {
  const known = new Set(knownIds.map(String));
  const products = new Set(productIds.map(String));
  return floItems.filter((i) => !known.has(String(i.id)) && products.has(String(i.product_id))).map((i) => String(i.id));
}

export async function runOnce(
  cfg: Cfg,
): Promise<{ sent: number; failed: number; synced: number; closed: number; cancelled: number; statuses: number; retryAfterMs: number }> {
  const http = clientFor(cfg);
  http.retryAfterMs = 0;
  const out = { sent: 0, failed: 0, synced: 0, closed: 0, cancelled: 0, statuses: 0, retryAfterMs: 0 };

  // 1) ออเดอร์ใหม่ → FloCafe
  const { jobs } = await http.pos("GET", "/jobs");
  for (const j of jobs as any[]) {
    const bad = j.items.find((i: any) => !i.posProductId);
    if (bad || (!j.posOrderId && !j.table.posTableId)) {
      const why = bad ? `สินค้าไม่ได้ผูกกับ FloCafe: ${bad.name}` : `โต๊ะไม่ได้ผูกกับ FloCafe: ${j.table.label}`;
      await http.pos("POST", `/jobs/${j.jobId}/result`, { ok: false, error: why, permanent: true });
      out.failed++;
      continue;
    }
    const items = j.items.map((i: any) => ({ product_id: num(i.posProductId), quantity: i.qty, ...(i.note ? { special_instructions: i.note } : {}) }));
    const key = `pos-${j.orderId}`; // ส่งซ้ำ (เครือข่ายหลุด) FloCafe คืนผลเดิม ไม่เกิดออเดอร์ซ้ำ
    try {
      const r = j.posOrderId
        ? await http.flo("POST", `/api/orders/${encodeURIComponent(j.posOrderId)}/items`, { items }, { "idempotency-key": key })
        : await http.flo("POST", "/api/orders", { type: "dine_in", table_id: num(j.table.posTableId), items, ...(j.note ? { special_instructions: j.note } : {}) }, { "idempotency-key": key });
      if (r.status >= 200 && r.status < 300) {
        const order = r.json?.order ?? r.json;
        const id = j.posOrderId ?? order?.id;
        if (id === undefined || id === null) throw new Error("flocafe response has no order id");
        const posItemIds = newItemIds(order?.items ?? [], j.knownPosItemIds ?? [], j.items.map((i: any) => i.posProductId));
        await http.pos("POST", `/jobs/${j.jobId}/result`, { ok: true, posOrderId: String(id), posItemIds });
        out.sent++;
      } else {
        // 4xx = ข้อมูลไม่ถูกต้อง/โต๊ะไม่ว่าง ลองซ้ำไม่ช่วย (ยกเว้น 408/429) ; 5xx ลองใหม่
        const permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
        await http.pos("POST", `/jobs/${j.jobId}/result`, { ok: false, permanent, error: `flocafe ${r.status}: ${JSON.stringify(r.json?.error ?? r.json).slice(0, 200)}` });
        out.failed++;
      }
    } catch (e) {
      await http.pos("POST", `/jobs/${j.jobId}/result`, { ok: false, error: String(e).slice(0, 200) }).catch(() => {});
      out.failed++;
    }
  }

  // 2) ความคืบหน้า/ชำระเงิน/ยกเลิกใน FloCafe → POS-Server (อ่านทีละออเดอร์ ไม่พึ่งรายการล่าสุด)
  const { bills } = await http.pos("GET", "/open-bills");
  for (const b of bills as any[]) {
    const r = await http.flo("GET", `/api/orders/${encodeURIComponent(b.pos_order_id)}`);
    if (r.status < 200 || r.status >= 300) continue;
    const o = r.json?.order ?? r.json;
    out.synced++;
    for (const g of (b.orders ?? []) as any[]) {
      const next = guestStatus(o?.items ?? [], g.posItemIds ?? []);
      if (!next || next === g.status || g.status === "served" || g.status === "cancelled") continue;
      if (next !== "cancelled" && (RANK[next] ?? 0) <= (RANK[g.status] ?? 0)) continue;
      await http.pos("POST", `/orders/${g.id}/status`, { status: next });
      out.statuses++;
    }
    if (isPaid(o)) {
      const res = await http.pos("POST", `/bills/${b.id}/paid`);
      if (!res.alreadyClosed) out.closed++;
    } else if (o?.status === "cancelled" && !/^Merged into /.test(String(o.cancellation_reason ?? ""))) {
      // รวมโต๊ะใน FloCafe ก็ยกเลิกออเดอร์ต้นทาง แต่ลูกค้ายังนั่งกินอยู่ จึงไม่ปิดบิล
      const res = await http.pos("POST", `/bills/${b.id}/cancelled`);
      if (!res.alreadyClosed) out.cancelled++;
    }
  }
  out.retryAfterMs = http.retryAfterMs;
  return out;
}

if (import.meta.main) {
  const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} is required`); })();
  const cfg: Cfg = {
    posUrl: env("POS_URL").replace(/\/$/, ""), posToken: env("POS_TOKEN"), posDevSlug: process.env.POS_DEV_SLUG,
    floUrl: env("FLO_URL").replace(/\/$/, ""), floEmail: env("FLO_EMAIL"), floPassword: env("FLO_PASSWORD"),
  };
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  let backoff = 1000;
  while (!stop) {
    try {
      const r = await runOnce(cfg);
      if (r.sent || r.failed || r.closed || r.cancelled || r.statuses) console.log(JSON.stringify({ level: "info", ...r }));
      backoff = 1000;
      await Bun.sleep(Math.max(1500, r.retryAfterMs));
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: String(e), retryMs: backoff }));
      await Bun.sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}
