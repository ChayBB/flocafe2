// Load test ต่อ API ที่กำลังรันอยู่ (รัน server แบบ NODE_ENV=production หลาย process ได้)
//   BENCH_URLS=http://127.0.0.1:3011,http://127.0.0.1:3012 BASE_DOMAIN=example.test \
//   ADMIN_DATABASE_URL=... GUEST_QR_SECRET=... bun run test/bench.ts
// หมายเหตุ: client รันเครื่องเดียวกับ server จึงกินทรัพยากรร่วมกัน ตัวเลขเป็นค่าต่ำสุดโดยประมาณ
import postgres from "postgres";
import { tableToken, randomToken } from "../src/crypto.ts";
import { cpus } from "node:os";

const URLS = (process.env.BENCH_URLS ?? "http://127.0.0.1:3011").split(",");
const DOMAIN = process.env.BASE_DOMAIN ?? "example.test";
const GUESTS = Number(process.env.BENCH_GUESTS ?? 300);
const MENU_SECONDS = Number(process.env.BENCH_MENU_SECONDS ?? 8);
const MENU_CONC = Number(process.env.BENCH_MENU_CONC ?? 200);
const admin = postgres(process.env.ADMIN_DATABASE_URL!, { max: 2, onnotice: () => {} });

const slug = "bench" + Math.random().toString(36).slice(2, 7);
const host = `${slug}.${DOMAIN}`;
const tid: string = (await admin`insert into tenant (slug, name) values (${slug}, 'bench') returning id`)[0]!.id;
await admin`update tenant set settings = ${admin.json({ order_cooldown_sec: 0 } as any)} where id = ${tid}`;
const menuIds: string[] = [];
for (let i = 0; i < 30; i++) {
  const [m] = await admin`insert into menu_item (tenant_id, name, price_satang, sort) values (${tid}, ${"item" + i}, ${3000 + i * 100}, ${i}) returning id`;
  menuIds.push(m!.id);
}
const tables = await admin`
  insert into dining_table ${admin(Array.from({ length: GUESTS }, (_, i) => ({ tenant_id: tid, label: "T" + i })))} returning id, qr_version`;

// เปิดบิลให้ทุกโต๊ะ (เทียบกับพนักงานกดเปิดโต๊ะก่อนลูกค้ามา)
await admin`insert into bill (tenant_id, table_id) select ${tid}, id from dining_table where tenant_id = ${tid}`;

let rr = 0;
const base = () => URLS[rr++ % URLS.length]!;
let ipc = 0;
const nextIp = () => `10.${(ipc >> 16) & 255}.${(ipc >> 8) & 255}.${ipc++ & 255}`;

async function req(method: string, path: string, ip: string, extra: Record<string, string> = {}, body?: unknown) {
  const t0 = performance.now();
  try {
    const res = await fetch(base() + path, {
      method,
      headers: { host, "x-real-ip": ip, ...(body ? { "content-type": "application/json" } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ms: performance.now() - t0, json: json as any };
  } catch {
    return { status: 0, ms: performance.now() - t0, json: null as any };
  }
}

function pct(a: number[], p: number) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
function summarize(name: string, lat: number[], statuses: Map<number, number>, secs: number) {
  const row = {
    phase: name,
    requests: lat.length,
    rps: Math.round(lat.length / secs),
    p50_ms: +pct(lat, 50).toFixed(1),
    p95_ms: +pct(lat, 95).toFixed(1),
    p99_ms: +pct(lat, 99).toFixed(1),
    status: Object.fromEntries(statuses),
  };
  console.log(JSON.stringify(row));
  return row;
}

console.log(JSON.stringify({ cpus: cpus().length, servers: URLS.length, guests: GUESTS, menuConcurrency: MENU_CONC }));

// ---- Phase 1: เมนู (cache ในหน่วยความจำ) ----
{
  const lat: number[] = [];
  const st = new Map<number, number>();
  const end = Date.now() + MENU_SECONDS * 1000;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: MENU_CONC }, async () => {
      while (Date.now() < end) {
        const r = await req("GET", "/api/menu", nextIp());
        lat.push(r.ms);
        st.set(r.status, (st.get(r.status) ?? 0) + 1);
      }
    }),
  );
  summarize("menu_cached", lat, st, (Date.now() - t0) / 1000);
}

// ---- Phase 2: ลูกค้า GUESTS คนสแกนพร้อมกันภายใน 5 วินาที: session → menu → order → poll×3 ----
{
  const lat: Record<string, number[]> = { session: [], menu: [], order: [], poll: [] };
  const st: Record<string, Map<number, number>> = { session: new Map(), menu: new Map(), order: new Map(), poll: new Map() };
  const rec = (k: string, r: { status: number; ms: number }) => {
    lat[k]!.push(r.ms);
    st[k]!.set(r.status, (st[k]!.get(r.status) ?? 0) + 1);
  };
  const t0 = Date.now();
  await Promise.all(
    tables.map(async (t, i) => {
      await Bun.sleep((i / GUESTS) * 5000);
      const ip = nextIp();
      const s = await req("POST", "/api/session", ip, {}, { token: tableToken(tid, t.id, t.qr_version) });
      rec("session", s);
      if (s.status !== 200) return;
      const auth = { authorization: `Bearer ${s.json.device}` };
      rec("menu", await req("GET", "/api/menu", ip));
      const items = [0, 1, 2].map((k) => ({ menuItemId: menuIds[(i + k) % menuIds.length]!, qty: 1 + (k % 2) }));
      rec("order", await req("POST", "/api/orders", ip, { ...auth, "idempotency-key": randomToken(16) }, { items }));
      for (let p = 0; p < 3; p++) {
        await Bun.sleep(200);
        rec("poll", await req("GET", "/api/orders", ip, auth));
      }
    }),
  );
  const secs = (Date.now() - t0) / 1000;
  for (const k of Object.keys(lat)) summarize(`rush_${k}`, lat[k]!, st[k]!, secs);
  const { n } = (await admin`select count(*)::int as n from orders where tenant_id = ${tid}`)[0]!;
  const { b } = (await admin`select count(*)::int as b from bill where tenant_id = ${tid}`)[0]!;
  console.log(JSON.stringify({ orders_in_db: n, bills_in_db: b, expected: GUESTS }));
}

await admin.end();
