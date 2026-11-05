import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const sql = postgres(url, {
  max: Number(process.env.DB_POOL ?? 10),
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
});

export type Tx = postgres.TransactionSql;

/** ทุกคำสั่งที่แตะข้อมูลของร้านต้องอยู่ใน transaction นี้ เพื่อให้ RLS ทำงาน */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant', ${tenantId}, true)`;
    return fn(tx);
  })) as T;
}

export interface TenantSettings {
  require_confirm?: boolean; // พนักงานยืนยันก่อนเข้าครัว
  order_token?: boolean; // ต้องมี order token ใช้ครั้งเดียวทุกครั้งที่ส่งออเดอร์
  pos_forward?: boolean; // ส่งออเดอร์ต่อไป POS ในร้านผ่าน connector
  confirm_first_only?: boolean; // ใช้คู่กับ require_confirm: ยืนยันเฉพาะออเดอร์แรกของบิล หลังพนักงานรับแล้วสั่งเพิ่มได้อัตโนมัติ
  require_open?: boolean; // default true: ต้องให้พนักงานเปิดโต๊ะก่อน ลูกค้าจึงสแกนเข้าได้
  order_cooldown_sec?: number; // default 15
  max_orders_per_bill?: number; // default 20
  max_devices_per_bill?: number; // default 12
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  settings: TenantSettings;
}

const clamp = (n: unknown, d: number, lo: number, hi: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;

export function policy(t: Tenant) {
  const s = t.settings ?? {};
  return {
    posForward: !!s.pos_forward,
    orderToken: !!s.order_token,
    requireConfirm: !!s.require_confirm,
    confirmFirstOnly: !!s.require_confirm && !!s.confirm_first_only,
    requireOpen: s.require_open !== false,
    cooldownSec: clamp(s.order_cooldown_sec, 15, 0, 600),
    maxOrdersPerBill: clamp(s.max_orders_per_bill, 20, 1, 500),
    maxDevicesPerBill: clamp(s.max_devices_per_bill, 12, 1, 50),
  };
}

const tenantCache = new Map<string, { exp: number; t: Tenant | null }>();

/** cache 60 วินาที: เปลี่ยน settings ผ่าน admin แล้วมีผลภายใน ~1 นาที */
export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const hit = tenantCache.get(slug);
  if (hit && hit.exp > Date.now()) return hit.t;
  const [row] = await sql<Tenant[]>`
    select id, slug, name, settings from tenant where slug = ${slug} and active`;
  const t = row ?? null;
  tenantCache.set(slug, { exp: Date.now() + (t ? 60_000 : 5_000), t });
  return t;
}

export interface NotifyOpts {
  id?: string;
  billId?: string; // ผู้ฟังฝั่งลูกค้าจะได้เฉพาะ event ของบิลตัวเอง
  reason?: string;
}

export function notify(tx: Tx, tenantId: string, type: string, o: NotifyOpts = {}) {
  return tx`select pg_notify('pos_events', ${JSON.stringify({ t: tenantId, type, id: o.id, b: o.billId, r: o.reason })})`;
}

export function enqueue(tx: Tx, tenantId: string, topic: string, payload: object) {
  return tx`insert into outbox (tenant_id, topic, payload) values (${tenantId}, ${topic}, ${tx.json(payload as never)})`;
}
