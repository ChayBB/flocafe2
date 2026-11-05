// Connector ในร้าน: ดึงงานจาก POS-Server (HTTPS ขาออกอย่างเดียว) แล้วส่งเข้า FloCafe (Server App :3003 ในเครื่อง/LAN)
// ไม่ต้องเปิดพอร์ตเข้าร้าน ไม่ต้องใช้ WireGuard (ถ้ายังต้องการ ใช้ได้เฉพาะเส้นทางไป FloCafe)
//
//   POS_URL=https://demo.order.example.com POS_TOKEN=<connector token> \
//   FLO_URL=http://127.0.0.1:3003 FLO_EMAIL=server@shop FLO_PASSWORD=... bun run connector/flocafe.ts
//
// FloCafe: ใช้บัญชีบทบาท server (สิทธิ์ server-app.use) — เรียกได้เฉพาะ GET /api/orders, POST /api/orders, POST /api/orders/:id/items
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
  constructor(private cfg: Cfg) {}
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
    if (!r.ok) throw new Error(`flocafe login -> ${r.status}`);
    this.jwt = ((await r.json()) as any).access_token;
  }
  async flo(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.jwt) await this.login();
      const h: Record<string, string> = { authorization: `Bearer ${this.jwt}`, ...extra };
      if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(this.cfg.floUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 401 && attempt === 0) { this.jwt = null; continue; } // token หมดอายุ → login ใหม่ครั้งเดียว
      return { status: r.status, json: await r.json().catch(() => null) };
    }
    throw new Error("unreachable");
  }
}

/** ออเดอร์ FloCafe → สถานะฝั่งลูกค้า (pending = พนักงานรับแล้ว) */
const STATUS: Record<string, string> = { pending: "accepted", preparing: "preparing", ready: "ready", served: "served", completed: "served", cancelled: "cancelled" };

/** ชำระเงินแล้วหรือไม่ — ตรวจจากสถานะบิลที่ FloCafe แนบมากับออเดอร์ (ต้องยืนยันกับเครื่องจริง) */
export function isPaid(o: any): boolean {
  if (o?.bill_payment_status === "paid") return true;
  return Array.isArray(o?.bills) && o.bills.length > 0 && o.bills.every((b: any) => b.payment_status === "paid");
}

export async function runOnce(cfg: Cfg): Promise<{ sent: number; failed: number; synced: number; closed: number }> {
  const http = new Http(cfg);
  const out = { sent: 0, failed: 0, synced: 0, closed: 0 };

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
        const id = j.posOrderId ?? r.json?.id ?? r.json?.order?.id;
        if (id === undefined || id === null) throw new Error("flocafe response has no order id");
        await http.pos("POST", `/jobs/${j.jobId}/result`, { ok: true, posOrderId: String(id) });
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

  // 2) ความคืบหน้า/ชำระเงินใน FloCafe → POS-Server
  const { bills } = await http.pos("GET", "/open-bills");
  if (bills.length) {
    const list = await http.flo("GET", "/api/orders?view=all&per_page=200");
    const orders: any[] = list.json?.orders ?? [];
    const byId = new Map(orders.map((o) => [String(o.id), o]));
    for (const b of bills as any[]) {
      const o = byId.get(String(b.pos_order_id));
      if (!o) continue;
      out.synced++;
      if (isPaid(o)) {
        const r = await http.pos("POST", `/bills/${b.id}/paid`);
        if (!r.alreadyClosed) out.closed++;
      }
    }
  }
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
      if (r.sent || r.failed || r.closed) console.log(JSON.stringify({ level: "info", ...r }));
      backoff = 1000;
      await Bun.sleep(1500);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: String(e), retryMs: backoff }));
      await Bun.sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}
