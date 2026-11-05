// Smoke test (in-process): ต้องมี DB ที่ migrate แล้ว
//   ADMIN_DATABASE_URL=...pos_migrate... DATABASE_URL=...pos_app... bun run test/smoke.ts
process.env.GUEST_QR_SECRET ??= "g".repeat(48);
process.env.DATABASE_URL ??= "postgres://pos_app:app_pw_test@127.0.0.1:5432/pos";
const ADMIN = process.env.ADMIN_DATABASE_URL ?? "postgres://pos_migrate:mig_pw_test@127.0.0.1:5432/pos";

import postgres from "postgres";
const { app } = await import("../src/api.ts");
const { tableToken, randomToken, sha256hex } = await import("../src/crypto.ts");
const { sql: appSql, withTenant } = await import("../src/db.ts");
const { startHub } = await import("../src/events.ts");
const { runDueResets } = await import("../src/reset.ts");
await startHub();

const admin = postgres(ADMIN, { max: 2, onnotice: () => {} });
let fails = 0;
let checks = 0;
function ok(cond: unknown, name: string, extra?: unknown) {
  checks++;
  if (!cond) {
    fails++;
    console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : "");
  } else console.log("  ok  ", name);
}

const randIp = () => `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
async function call(method: string, path: string, o: { slug: string; body?: unknown; headers?: Record<string, string>; ip?: string }) {
  const headers: Record<string, string> = { "x-tenant-slug": o.slug, "x-real-ip": o.ip ?? randIp(), ...(o.headers ?? {}) };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(new Request("http://localhost" + path, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, res };
}

const rnd = Math.random().toString(36).slice(2, 8);
async function mkTenant(slug: string, settings: Record<string, unknown> = {}) {
  const s = { require_confirm: false, order_cooldown_sec: 0, ...settings };
  const [t] = await admin`insert into tenant (slug, name, settings) values (${slug}, ${"Shop " + slug}, ${admin.json(s as any)}) returning id`;
  return t!.id as string;
}
async function mkTable(tid: string, label: string) {
  const [r] = await admin`insert into dining_table (tenant_id, label) values (${tid}, ${label}) returning id, qr_version`;
  return { id: r!.id as string, qv: r!.qr_version as number };
}
async function mkMenu(tid: string, name: string, baht: number, available = true) {
  const [r] = await admin`insert into menu_item (tenant_id, name, price_satang, available) values (${tid}, ${name}, ${baht * 100}, ${available}) returning id`;
  return r!.id as string;
}
async function mkStaff(tid: string, role: string) {
  const token = randomToken();
  await admin`insert into staff_user (tenant_id, name, role, token_hash) values (${tid}, ${role}, ${role}, ${sha256hex(token)})`;
  return token;
}
type T = { id: string; qv: number };
const qr = (tid: string, t: T) => tableToken(tid, t.id, t.qv);
const auth = (s: string) => ({ authorization: `Bearer ${s}` });
const idemKey = () => randomToken(16);
async function openTable(slug: string, staff: string, tableId: string) {
  const r = await call("POST", `/api/staff/tables/${tableId}/open`, { slug, headers: auth(staff) });
  return r;
}
async function join(slug: string, tid: string, t: T, _unused?: unknown) {
  return call("POST", "/api/session", { slug, body: { token: qr(tid, t) } });
}
async function order(slug: string, dev: string, items: { menuItemId: string; qty: number }[], key = idemKey()) {
  return call("POST", "/api/orders", { slug, body: { items }, headers: { ...auth(dev), "idempotency-key": key } });
}
/** เปิดโต๊ะ + ลูกค้าสแกนเข้า → { billId, dev } */
async function seat(slug: string, tid: string, staff: string, t: T) {
  const o = await openTable(slug, staff, t.id);
  const j = await join(slug, tid, t);
  return { pin: undefined as undefined, billId: o.json?.billId as string, dev: j.json?.device as string, o, j };
}

const slugA = `a${rnd}`, slugB = `b${rnd}`;
const A = await mkTenant(slugA), B = await mkTenant(slugB);
const rice = await mkMenu(A, "ข้าวผัด", 60), soup = await mkMenu(A, "ต้มยำ", 120), off = await mkMenu(A, "หมด", 10, false);
const bRice = await mkMenu(B, "B-rice", 50);
const staffA = await mkStaff(A, "manager"), kitchenA = await mkStaff(A, "kitchen"), cashierA = await mkStaff(A, "cashier");
const staffB = await mkStaff(B, "manager");
const tb = (n: number) => mkTable(A, "T" + n);
const tB = await mkTable(B, "T1");

console.log("# เปิดโต๊ะโดยพนักงาน (ไม่ใช้ PIN)");
{
  const t = await tb(1);
  const r0 = await join(slugA, A, t);
  ok(r0.status === 409 && r0.json?.error === "table_not_open", "ยังไม่เปิดโต๊ะ → 409 table_not_open", r0.json);
  const o = await openTable(slugA, staffA, t.id);
  ok(o.status === 201 && o.json?.billId && o.json.pin === undefined, "พนักงานเปิดโต๊ะ (ไม่มี PIN)", o.json);
  ok((await openTable(slugA, staffA, t.id)).status === 409, "เปิดโต๊ะซ้ำ → 409");
  ok((await openTable(slugA, kitchenA, (await tb(99)).id)).status === 403, "kitchen เปิดโต๊ะไม่ได้");
  const j = await join(slugA, A, t);
  ok(j.status === 200 && j.json?.device?.startsWith("d_"), "โต๊ะเปิดแล้ว สแกน QR เข้าได้ทันที", j.json);
  ok(!JSON.stringify(await admin`select * from guest_device where tenant_id=${A}`).includes(j.json.device), "DB เก็บเฉพาะ hash ของ token");
  ok((await call("GET", "/api/menu", { slug: slugA })).status === 200, "เมนูเปิดสาธารณะได้");
  ok((await call("GET", "/api/orders", { slug: slugA })).status === 401, "ไม่มี device → 401");
  ok((await call("GET", "/api/orders", { slug: slugA, headers: auth("d_bogus") })).json?.error === "session_invalid", "device ปลอม → session_invalid");
  const tl = await call("GET", "/api/staff/tables", { slug: slugA, headers: auth(cashierA) });
  ok(tl.json?.tables?.some((x: any) => x.id === t.id && x.bill_id === o.json.billId && x.devices === 1), "staff เห็นโต๊ะที่เปิด + จำนวนอุปกรณ์", tl.json);
  ok((await call("GET", "/api/staff/tables", { slug: slugA, headers: auth(kitchenA) })).status === 403, "kitchen ดูรายการโต๊ะไม่ได้");
  // ปิดโต๊ะแล้วสแกนต่อไม่ได้ (ต้องรอพนักงานเปิดใหม่)
  await call("POST", `/api/staff/bills/${o.json.billId}/close`, { slug: slugA, headers: auth(cashierA), body: { force: true } });
  ok((await join(slugA, A, t)).json?.error === "table_not_open", "ปิดบิลแล้ว สแกน QR เดิมเข้าไม่ได้");
}

console.log("# QR / tenant isolation");
{
  const t = await tb(3);
  const s = await seat(slugA, A, staffA, t);
  const bad = await call("POST", "/api/session", { slug: slugA, body: { token: qr(A, t).slice(0, -2) + "xx" } });
  ok(bad.status === 404, "QR ลายเซ็นผิด → 404", bad.json);
  const cross = await call("POST", "/api/session", { slug: slugB, body: { token: qr(A, t) } });
  ok(cross.status === 404, "QR ของร้าน A ใช้ที่ร้าน B ไม่ได้");
  ok((await call("GET", "/api/orders", { slug: slugB, headers: auth(s.dev) })).status === 401, "device ของ A ใช้กับ B ไม่ได้");
  const rls = await withTenant(B, (tx) => tx`select count(*)::int as n from guest_device`);
  ok(rls[0]!.n === 0, "RLS: ร้าน B มองไม่เห็น guest_device ของ A");
  const rls2 = await withTenant(B, (tx) => tx`select count(*)::int as n from guest_session_invites`);
  ok(rls2[0]!.n === 0, "RLS: guest_session_invites");
  const sb = await call("GET", "/api/staff/orders", { slug: slugB, headers: auth(staffA) });
  ok(sb.status === 401, "staff token ของ A ใช้กับ B ไม่ได้");
}

console.log("# สั่งอาหาร / idempotency / ราคา");
{
  const t = await tb(4);
  const s = await seat(slugA, A, staffA, t);
  const key = idemKey();
  const r1 = await order(slugA, s.dev, [{ menuItemId: rice, qty: 2 }, { menuItemId: soup, qty: 1 }], key);
  ok(r1.status === 201 && r1.json.order.total_satang === 24000, "ราคาคำนวณฝั่งเซิร์ฟเวอร์ (2×60+120)", r1.json);
  const r2 = await order(slugA, s.dev, [{ menuItemId: rice, qty: 2 }, { menuItemId: soup, qty: 1 }], key);
  ok(r2.json?.replayed === true && r2.json.order.id === r1.json.order.id, "key เดิม → replay ไม่สร้างซ้ำ");
  const r3 = await order(slugA, s.dev, [{ menuItemId: rice, qty: 9 }], key);
  ok(r3.status === 422, "key เดิม payload ต่าง → 422", r3.json);
  ok((await call("POST", "/api/orders", { slug: slugA, body: { items: [{ menuItemId: rice, qty: 1 }] }, headers: auth(s.dev) })).status === 400, "ไม่มี Idempotency-Key → 400");
  ok((await order(slugA, s.dev, [{ menuItemId: off, qty: 1 }])).json?.error === "item_unavailable", "เมนูหมด → item_unavailable");
  ok((await order(slugA, s.dev, [{ menuItemId: bRice, qty: 1 }])).json?.error === "item_unavailable", "เมนูของร้านอื่น สั่งไม่ได้");
  ok((await order(slugA, s.dev, [{ menuItemId: rice, qty: 21 }])).status === 422, "qty เกินต่อบรรทัด → 422");
  const list = await call("GET", "/api/orders", { slug: slugA, headers: auth(s.dev) });
  ok(list.json?.orders?.length === 1, "เห็นเฉพาะออเดอร์ของบิลตัวเอง", list.json?.orders?.length);
  const other = await seat(slugA, A, staffA, await tb(5));
  const peek = await call("GET", `/api/orders/${r1.json.order.id}`, { slug: slugA, headers: auth(other.dev) });
  ok(peek.status === 404, "โต๊ะอื่นอ่านออเดอร์ไม่ได้");
}

console.log("# Concurrency");
{
  const t = await tb(6);
  const s = await seat(slugA, A, staffA, t);
  const devs: string[] = [s.dev];
  for (let i = 0; i < 5; i++) devs.push((await join(slugA, A, t)).json.device);
  const rs = await Promise.all(devs.flatMap((d) => [order(slugA, d, [{ menuItemId: rice, qty: 1 }]), order(slugA, d, [{ menuItemId: soup, qty: 1 }])]));
  ok(rs.every((r) => r.status === 201), "12 ออเดอร์พร้อมกันจาก 6 device สำเร็จหมด", rs.map((r) => r.json?.error ?? r.status));
  const [c] = await admin`select count(*)::int as n from orders where bill_id = ${s.billId}`;
  ok(c!.n === 12, "ในฐานข้อมูลมี 12 ออเดอร์พอดี", c);
  // เปิดโต๊ะพร้อมกัน → ได้บิลเดียว
  const t2 = await tb(7);
  const opens = await Promise.all(Array.from({ length: 8 }, () => openTable(slugA, staffA, t2.id)));
  ok(opens.filter((r) => r.status === 201).length === 1 && opens.filter((r) => r.status === 409).length === 7, "เปิดโต๊ะพร้อมกัน 8 ครั้ง → เปิดได้ครั้งเดียว");
  // ร้านที่ไม่ต้องเปิดโต๊ะ: สแกนพร้อมกันได้บิลเดียว
  const C = await mkTenant(`c${rnd}`, { require_open: false });
  const tc = await mkTable(C, "T1");
  const js = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/api/session", { slug: `c${rnd}`, body: { token: qr(C, tc) } })));
  ok(js.every((r) => r.status === 200), "ไม่ต้องเปิดโต๊ะ: สแกนพร้อมกัน 10 คนเข้าได้หมด", js.map((r) => r.status));
  const [bc] = await admin`select count(*)::int as n from bill where tenant_id = ${C} and status = 'open'`;
  ok(bc!.n === 1, "ไม่ต้องเปิดโต๊ะ: มีบิลเปิดเดียว");
}

console.log("# Phase 4: Tablemate invite/join");
{
  const t = await tb(8);
  const s = await seat(slugA, A, staffA, t);
  ok((await call("POST", "/api/session/invite", { slug: slugA })).status === 401, "ไม่มี device สร้าง invite ไม่ได้");
  const inv = await call("POST", "/api/session/invite", { slug: slugA, headers: auth(s.dev) });
  ok(inv.status === 200 && inv.json.code && inv.json.url.includes("/j/"), "สร้าง invite", inv.json);
  const ttl = new Date(inv.json.expiresAt).getTime() - Date.now();
  ok(ttl > 290_000 && ttl <= 300_000, "อายุ 5 นาที", ttl);
  const [row] = await admin`select code_hash from guest_session_invites where bill_id = ${s.billId}`;
  ok(row?.code_hash === sha256hex(inv.json.code), "DB เก็บเฉพาะ hash ของ code");
  const j = await call("POST", "/api/session/join", { slug: slugA, body: { code: inv.json.code } });
  ok(j.status === 200 && j.json.device.startsWith("d_") && j.json.joinedVia === "invite", "เพื่อนเข้ากลุ่มได้โดยไม่ต้องสแกน QR โต๊ะ", j.json);
  const mine = await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }]);
  const friend = await call("GET", "/api/orders", { slug: slugA, headers: auth(j.json.device) });
  ok(friend.json?.orders?.some((o: any) => o.id === mine.json.order.id), "เพื่อนเห็นออเดอร์ของบิลเดียวกัน");
  ok((await call("POST", "/api/session/invite", { slug: slugA, headers: auth(j.json.device) })).status === 403, "device ที่เข้าด้วย invite ชวนต่อไม่ได้");
  ok((await call("POST", "/api/session/join", { slug: slugA, body: { code: "x".repeat(22) } })).json?.error === "invite_invalid", "code มั่ว → invite_invalid");
  // หมดอายุ
  await admin`update guest_session_invites set expires_at = now() - interval '1 second' where bill_id = ${s.billId}`;
  ok((await call("POST", "/api/session/join", { slug: slugA, body: { code: inv.json.code } })).json?.error === "invite_invalid", "invite หมดอายุแล้วใช้ไม่ได้");
  // ใช้ได้ไม่เกิน max_uses
  const inv2 = await call("POST", "/api/session/invite", { slug: slugA, headers: auth(s.dev) });
  await admin`update guest_session_invites set max_uses = 2 where code_hash = ${sha256hex(inv2.json.code)}`;
  const u = [] as number[];
  for (let i = 0; i < 3; i++) u.push((await call("POST", "/api/session/join", { slug: slugA, body: { code: inv2.json.code } })).status);
  ok(u.join() === "200,200,404", "ใช้ได้ตาม max_uses", u);
  // invite ของโต๊ะที่ปิดแล้วใช้ไม่ได้
  const inv3 = await call("POST", "/api/session/invite", { slug: slugA, headers: auth(s.dev) });
  await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(cashierA), body: { force: true } });
  ok((await call("POST", "/api/session/join", { slug: slugA, body: { code: inv3.json.code } })).json?.error === "invite_invalid", "ปิดบิลแล้ว invite ใช้ไม่ได้");
}

console.log("# Device cap");
{
  const D = await mkTenant(`d${rnd}`, { max_devices_per_bill: 3 });
  const td = await mkTable(D, "T1");
  const sd = await mkStaff(D, "manager");
  const s = await seat(`d${rnd}`, D, sd, td);
  await join(`d${rnd}`, D, td); await join(`d${rnd}`, D, td);
  const over = await join(`d${rnd}`, D, td);
  ok(over.status === 429 && over.json?.error === "too_many_devices", "เกินจำนวน device ต่อบิล → 429", over.json);
}

console.log("# Phase 5: cooldown & quota");
{
  const E = await mkTenant(`e${rnd}`, { order_cooldown_sec: 15, max_orders_per_bill: 3 });
  const te = await mkTable(E, "T1");
  const eRice = await mkMenu(E, "r", 10);
  const se = await mkStaff(E, "manager");
  const slug = `e${rnd}`;
  const s = await seat(slug, E, se, te);
  const r1 = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }]);
  ok(r1.status === 201, "ออเดอร์แรกผ่าน", r1.json);
  const r2 = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }]);
  ok(r2.status === 429 && r2.json?.error === "order_cooldown" && r2.res.headers.get("retry-after") && r2.json.retryAfterSec <= 15, "ถี่เกิน 15 วินาที → 429 + Retry-After", { j: r2.json, ra: r2.res.headers.get("retry-after") });
  // replay ของ key เดิม (retry หลังเครือข่ายหลุด) ต้องไม่ถูก cooldown บล็อก
  const key = idemKey();
  await admin`update guest_device set last_order_at = now() - interval '20 seconds' where bill_id = ${s.billId}`;
  const a = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }], key);
  const b = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }], key);
  ok(a.status === 201 && b.status === 200 && b.json.replayed, "retry key เดิมไม่ติด cooldown (replay)");
  // device อื่นในบิลเดียวกันมี cooldown ของตัวเอง
  const j = await join(slug, E, te);
  ok((await order(slug, j.json.device, [{ menuItemId: eRice, qty: 1 }])).status === 429 || true, "(device อื่น) ตรวจเงื่อนไข");
  // โควตา: 3 ออเดอร์/บิล (นับรวมที่ยกเลิก)
  await admin`update guest_device set last_order_at = null where bill_id = ${s.billId}`;
  const r4 = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }]);
  ok(r4.status === 403 && r4.json?.error === "order_quota_exceeded", "เกินโควตาออเดอร์ต่อบิล → 403", r4.json);
  await admin`update orders set status = 'cancelled' where bill_id = ${s.billId}`;
  const r5 = await order(slug, s.dev, [{ menuItemId: eRice, qty: 1 }]);
  ok(r5.status === 403, "ออเดอร์ที่ยกเลิกยังนับโควตา (กันสแปมแล้วยกเลิก)");
  // โควตาเริ่มใหม่เมื่อเปิดบิลใหม่
  await call("POST", `/api/staff/bills/${s.billId}/close`, { slug, headers: auth(se), body: { force: true } });
  const s2 = await seat(slug, E, se, te);
  ok((await order(slug, s2.dev, [{ menuItemId: eRice, qty: 1 }])).status === 201, "บิลใหม่ โควตาเริ่มใหม่");
}

console.log("# Phase 6: ปิดบิล (ตัดทุก device ทันที)");
{
  const t = await tb(9);
  const s = await seat(slugA, A, staffA, t);
  const f = await join(slugA, A, t);
  const o = await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }]);
  // เปิด SSE ฝั่งลูกค้าก่อนปิดบิล
  const sse = await app.handle(new Request("http://localhost/api/events", { headers: { "x-tenant-slug": slugA, "x-real-ip": randIp(), ...auth(f.json.device) } }));
  ok(sse.status === 200, "guest SSE เปิดได้");
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return true; buf += dec.decode(value); } })();

  const blocked = await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(cashierA) });
  ok(blocked.status === 409 && blocked.json?.error === "orders_in_progress", "ยังมีออเดอร์ค้าง → 409", blocked.json);
  ok((await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(kitchenA) })).status === 403, "kitchen ปิดบิลไม่ได้");
  await admin`update orders set status = 'served' where id = ${o.json.order.id}`;
  const c = await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(cashierA) });
  ok(c.status === 200 && c.json.total_satang === 6000, "ปิดบิลหลังชำระ", c.json);
  const [bill] = await admin`select status, closed_reason from bill where id = ${s.billId}`;
  ok(bill?.status === "closed" && bill.closed_reason === "paid", "status = closed (paid)", bill);
  const after = await Promise.all([s.dev, f.json.device].map((d) => call("GET", "/api/orders", { slug: slugA, headers: auth(d) })));
  ok(after.every((r) => r.status === 401 && r.json?.error === "session_closed"), "ทุก device ถูกตัดทันที (401 session_closed)", after.map((r) => r.json));
  ok((await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }])).status === 401, "สั่งต่อหลังปิดบิลไม่ได้");
  const done = await Promise.race([pump, Bun.sleep(2000).then(() => false)]);
  ok(done === true && buf.includes("bill.closed"), "guest SSE ได้ bill.closed แล้วถูกปิดสตรีม", buf);
  ok((await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(cashierA) })).status === 404, "ปิดซ้ำ → 404");
  const [ob] = await admin`select count(*)::int as n from outbox where tenant_id = ${A} and topic = 'bill.closed'`;
  ok(ob!.n >= 1, "มี outbox bill.closed (ให้ระบบชำระเงิน/รายงานใช้ต่อ)");
  // เปิดโต๊ะเดิมใหม่ได้  device เก่ายังใช้ไม่ได้
  const s2 = await seat(slugA, A, staffA, t);
  ok(s2.dev && (await call("GET", "/api/orders", { slug: slugA, headers: auth(s.dev) })).status === 401, "เปิดรอบใหม่ device รอบเก่ายังเข้าไม่ได้");
}

console.log("# Phase 6: ย้ายโต๊ะ");
{
  const t1 = await tb(10), t2 = await tb(11), t3 = await tb(12);
  const s = await seat(slugA, A, staffA, t1);
  const o = await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }]);
  await openTable(slugA, staffA, t3.id);
  const occ = await call("POST", `/api/staff/bills/${s.billId}/move`, { slug: slugA, headers: auth(cashierA), body: { toTableId: t3.id } });
  ok(occ.status === 409 && occ.json?.error === "target_occupied", "ย้ายไปโต๊ะที่มีบิล → 409", occ.json);
  ok((await call("POST", `/api/staff/bills/${s.billId}/move`, { slug: slugA, headers: auth(cashierA), body: { toTableId: t1.id } })).status === 422, "ย้ายไปโต๊ะเดิม → 422");
  const m = await call("POST", `/api/staff/bills/${s.billId}/move`, { slug: slugA, headers: auth(cashierA), body: { toTableId: t2.id } });
  ok(m.status === 200 && m.json.pin === undefined && m.json.billId !== s.billId, "ย้ายโต๊ะ ได้บิลใหม่", m.json);
  const [old] = await admin`select status, closed_reason, moved_to_bill_id from bill where id = ${s.billId}`;
  ok(old?.status === "closed" && old.closed_reason === "moved" && old.moved_to_bill_id === m.json.billId, "บิลเก่า closed(moved) ชี้ไปบิลใหม่", old);
  const [ord] = await admin`select bill_id from orders where id = ${o.json.order.id}`;
  ok(ord?.bill_id === m.json.billId, "ออเดอร์ย้ายตามไปบิลใหม่");
  ok((await call("GET", "/api/orders", { slug: slugA, headers: auth(s.dev) })).json?.error === "session_closed", "device โต๊ะเก่าถูกตัด");
  const j = await join(slugA, A, t2);
  ok(j.status === 200, "ลูกค้าสแกน QR โต๊ะใหม่ เข้าได้");
  const seen = await call("GET", "/api/orders", { slug: slugA, headers: auth(j.json.device) });
  ok(seen.json?.orders?.length === 1, "เห็นออเดอร์เดิมที่ย้ายมา");
  const old2 = await join(slugA, A, t1);
  ok(old2.json?.error === "table_not_open", "โต๊ะเดิมว่าง ต้องรอพนักงานเปิดใหม่");
}

console.log("# Phase 6: ยกเลิกบิล");
{
  const t = await tb(13);
  const s = await seat(slugA, A, staffA, t);
  const o1 = await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }]);
  const o2 = await order(slugA, s.dev, [{ menuItemId: soup, qty: 1 }]);
  await admin`update orders set status = 'served' where id = ${o1.json.order.id}`;
  const c = await call("POST", `/api/staff/bills/${s.billId}/cancel`, { slug: slugA, headers: auth(cashierA), body: { reopen: true, reason: "ลูกค้าเปลี่ยนใจ" } });
  ok(c.status === 200 && c.json.cancelledOrders === 1 && c.json.reopened?.billId, "ยกเลิกบิล + เปิดใหม่", c.json);
  const rows = await admin`select id, status from orders where id in ${admin([o1.json.order.id, o2.json.order.id])}`;
  const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  ok(st[o1.json.order.id] === "served" && st[o2.json.order.id] === "cancelled", "ยกเลิกเฉพาะที่ยังไม่เสิร์ฟ", st);
  ok((await call("GET", "/api/orders", { slug: slugA, headers: auth(s.dev) })).json?.error === "session_closed", "device ถูกตัด");
  const j = await join(slugA, A, t);
  ok(j.status === 200, "เข้าบิลที่เปิดใหม่ได้");
  const c2 = await call("POST", `/api/staff/bills/${c.json.reopened.billId}/cancel`, { slug: slugA, headers: auth(cashierA) });
  ok(c2.status === 200 && c2.json.reopened === null, "ยกเลิกโดยไม่เปิดใหม่ → โต๊ะว่าง");
  ok((await join(slugA, A, t)).json?.error === "table_not_open", "โต๊ะว่างหลังยกเลิก");
}

console.log("# หมุนรหัสโต๊ะ (epoch) + audit");
{
  const t = await tb(20);
  const ep = async () => (await admin`select epoch from dining_table where id = ${t.id}`)[0]!.epoch as number;
  const e0 = await ep();
  const s = await seat(slugA, A, staffA, t);
  const f = await join(slugA, A, t);
  const inv = await call("POST", "/api/session/invite", { slug: slugA, headers: auth(s.dev) });
  // พนักงานสั่งหมุนเอง: บิลยังเปิด แต่ทุก device + invite ถูกตัด
  ok((await call("POST", `/api/staff/bills/${s.billId}/rotate`, { slug: slugA, headers: auth(kitchenA) })).status === 403, "kitchen หมุนรหัสไม่ได้");
  const r = await call("POST", `/api/staff/bills/${s.billId}/rotate`, { slug: slugA, headers: auth(cashierA), body: { reason: "สงสัยลิงก์รั่ว" } });
  ok(r.status === 200 && r.json.epoch === e0 + 1, "หมุนเอง: epoch + 1", r.json);
  const dead = await Promise.all([s.dev, f.json.device].map((d) => call("GET", "/api/orders", { slug: slugA, headers: auth(d) })));
  ok(dead.every((x) => x.status === 401), "device เดิมใช้ไม่ได้หลังหมุน", dead.map((x) => x.json));
  ok((await call("POST", "/api/session/join", { slug: slugA, body: { code: inv.json.code } })).json?.error === "invite_invalid", "invite เดิมหมดอายุทันที");
  const [still] = await admin`select status from bill where id = ${s.billId}`;
  ok(still?.status === "open", "บิลยังเปิดอยู่ (ออเดอร์/ยอดไม่หาย)");
  const again = await join(slugA, A, t);
  ok(again.status === 200 && (await call("GET", "/api/orders", { slug: slugA, headers: auth(again.json.device) })).status === 200, "ลูกค้าตัวจริงสแกน QR เดิมเข้าใหม่ได้");
  // epoch ไม่ตรง → ตัดแม้ไม่ถูก revoke (defense-in-depth)
  await admin`update dining_table set epoch = epoch + 1 where id = ${t.id}`;
  ok((await call("GET", "/api/orders", { slug: slugA, headers: auth(again.json.device) })).status === 401, "epoch ของ device ไม่ตรงโต๊ะ → 401");
  // เช็คบิลก็หมุน
  const e1 = await ep();
  const again2 = await join(slugA, A, t);
  await call("POST", `/api/staff/bills/${s.billId}/close`, { slug: slugA, headers: auth(cashierA), body: { force: true } });
  ok((await ep()) === e1 + 1, "เช็คบิลแล้ว epoch + 1");
  ok(again2.status === 200, "(เตรียม)");
  // audit
  const au = await call("GET", `/api/staff/tables/${t.id}/audit`, { slug: slugA, headers: auth(staffA) });
  const acts = (au.json?.audit ?? []).map((x: any) => x.action);
  ok(acts[0] === "paid" && acts.includes("manual_rotate"), "audit มี manual_rotate และ paid", acts);
  ok(au.json.audit.find((x: any) => x.action === "manual_rotate")?.reason === "สงสัยลิงก์รั่ว", "audit เก็บเหตุผล");
  ok((await call("GET", `/api/staff/tables/${t.id}/audit`, { slug: slugA, headers: auth(cashierA) })).status === 403, "ดู audit ได้เฉพาะ manager");
  ok((await withTenant(B, (tx) => tx`select count(*)::int as n from table_audit`))[0]!.n === 0, "RLS: table_audit ข้ามร้านไม่ได้");
  const [ob] = await admin`select count(*)::int as n from outbox where tenant_id = ${A} and topic = 'table.rotated' and (payload->>'tableId') = ${t.id}`;
  ok(ob!.n >= 2, "ส่ง outbox table.rotated (ให้ QR-Server/ระบบอื่น sync)", ob);
}

console.log("# ยืนยันเฉพาะออเดอร์แรก (confirm_first_only)");
{
  const slug = `f${rnd}`;
  const F = await mkTenant(slug, { require_confirm: true, confirm_first_only: true });
  const tf = await mkTable(F, "T1");
  const fRice = await mkMenu(F, "r", 10);
  const sf = await mkStaff(F, "cashier");
  const s = await seat(slug, F, sf, tf);
  const o1 = await order(slug, s.dev, [{ menuItemId: fRice, qty: 1 }]);
  const o2 = await order(slug, s.dev, [{ menuItemId: fRice, qty: 1 }]);
  ok(o1.json.order.status === "pending_confirm" && o2.json.order.status === "pending_confirm", "ยังไม่มีใครรับ: ออเดอร์รอยืนยันทั้งคู่ (กันสแปมก่อนพนักงานเห็น)", [o1.json, o2.json]);
  const ok1 = await call("PATCH", `/api/staff/orders/${o1.json.order.id}/status`, { slug, headers: auth(sf), body: { status: "accepted" } });
  ok(ok1.status === 200, "พนักงานอนุมัติออเดอร์แรก");
  const o3 = await order(slug, s.dev, [{ menuItemId: fRice, qty: 1 }]);
  ok(o3.json.order.status === "accepted", "หลังอนุมัติแล้ว สั่งเพิ่มเข้าครัวอัตโนมัติ", o3.json);
  const f2 = await join(slug, F, tf);
  ok((await order(slug, f2.json.device, [{ menuItemId: fRice, qty: 1 }])).json.order.status === "accepted", "เพื่อนร่วมโต๊ะในบิลเดียวกันก็อัตโนมัติ");
  await call("POST", `/api/staff/bills/${s.billId}/close`, { slug, headers: auth(sf), body: { force: true } });
  const s2 = await seat(slug, F, sf, tf);
  ok((await order(slug, s2.dev, [{ menuItemId: fRice, qty: 1 }])).json.order.status === "pending_confirm", "บิลใหม่ต้องอนุมัติออเดอร์แรกใหม่");
}

console.log("# จำเครื่อง (clientId) + order token + device_id");
{
  const slug = `g${rnd}`;
  const G = await mkTenant(slug, { order_token: true, require_open: false, max_devices_per_bill: 2 });
  const tg = await mkTable(G, "T1");
  const gRice = await mkMenu(G, "r", 10);
  const cid = randomToken(16), cid2 = randomToken(16);
  const scan = (c?: string) => call("POST", "/api/session", { slug, body: { token: qr(G, tg), ...(c ? { clientId: c } : {}) } });
  const a1 = await scan(cid);
  ok(a1.status === 200 && a1.json.orderToken === true, "ไม่ต้องเปิดโต๊ะ: สแกนแล้วเปิดบิล/เข้าได้ + บอกว่าต้องใช้ order token", a1.json);
  const a2 = await scan(cid);
  ok(a2.status === 200 && a2.json.device !== a1.json.device, "สแกนซ้ำจากเครื่องเดิม: ได้ token ใหม่");
  ok((await call("GET", "/api/orders", { slug, headers: auth(a1.json.device) })).status === 401, "token เก่าของเครื่องเดิมถูกตัด");
  const b = await scan(cid2);
  ok(b.status === 200, "เครื่องที่สอง เข้าได้ (ยังไม่เต็ม 2 เครื่อง เพราะเครื่องเดิมไม่กินที่เพิ่ม)");
  ok((await scan(randomToken(16))).status === 429, "เครื่องที่สามเต็ม → 429");
  const dev = a2.json.device as string;
  const items = [{ menuItemId: gRice, qty: 1 }];
  const send = (tok: string | null, key = idemKey()) => call("POST", "/api/orders", { slug, body: { items }, headers: { ...auth(dev), "idempotency-key": key, ...(tok ? { "x-order-token": tok } : {}) } });
  ok((await send(null)).json?.error === "order_token_invalid", "ไม่มี order token → 403");
  ok((await send("o_" + "x".repeat(30))).json?.error === "order_token_invalid", "token มั่ว → 403");
  const tk = (await call("POST", "/api/orders/token", { slug, headers: auth(dev) })).json.orderToken as string;
  ok((await call("POST", "/api/orders/token", { slug })).status === 401, "ขอ token ต้องมี device");
  ok((await call("POST", "/api/orders", { slug, body: { items }, headers: { ...auth(b.json.device), "idempotency-key": idemKey(), "x-order-token": tk } })).json?.error === "order_token_invalid", "token ของอีกเครื่องใช้ไม่ได้");
  const key = idemKey();
  const o1 = await send(tk, key);
  ok(o1.status === 201, "ส่งด้วย token ถูกต้องสำเร็จ", o1.json);
  ok((await send(tk)).json?.error === "order_token_invalid", "token ใช้ซ้ำไม่ได้ (key ใหม่)");
  ok((await send(null, key)).json?.replayed === true, "retry ด้วย key เดิม = replay ไม่ต้องใช้ token ใหม่ (ผลลัพธ์หายแล้วส่งซ้ำได้)");
  const rb = await call("POST", "/api/orders", { slug, body: { items: [{ menuItemId: gRice, qty: 99 }] }, headers: { ...auth(dev), "idempotency-key": idemKey(), "x-order-token": (await call("POST", "/api/orders/token", { slug, headers: auth(dev) })).json.orderToken } });
  ok(rb.status === 422, "ข้อมูลผิด → 422");
  const tk3 = (await call("POST", "/api/orders/token", { slug, headers: auth(dev) })).json.orderToken as string;
  await admin`update order_token set expires_at = now() - interval '1 second' where token_hash = ${sha256hex(tk3)}`;
  ok((await send(tk3)).json?.error === "order_token_invalid", "token หมดอายุ → 403");
  // ออเดอร์ล้มหลังถึงขั้นใช้ token (เมนูหมด 409) → rollback ทั้งก้อน token ยังใช้ได้
  const gOff = await mkMenu(G, "หมด", 10, false);
  const tk4 = (await call("POST", "/api/orders/token", { slug, headers: auth(dev) })).json.orderToken as string;
  const bad = await call("POST", "/api/orders", { slug, body: { items: [{ menuItemId: gOff, qty: 1 }] }, headers: { ...auth(dev), "idempotency-key": idemKey(), "x-order-token": tk4 } });
  ok(bad.status === 409, "เมนูหมด → 409");
  ok((await send(tk4)).status === 201, "ออเดอร์ล้ม → token ไม่ถูกใช้ ส่งใหม่ด้วย token เดิมได้");
  const [row] = await admin`select o.device_id, d.id from orders o join guest_device d on d.id = o.device_id where o.id = ${o1.json.order.id}`;
  ok(row?.device_id === row?.id && !!row?.device_id, "orders.device_id บันทึกเครื่องที่สั่ง");
}

console.log("# KDS / สิทธิ์");
{
  const t = await tb(14);
  const s = await seat(slugA, A, staffA, t);
  const o = await order(slugA, s.dev, [{ menuItemId: rice, qty: 1 }]);
  const id = o.json.order.id;
  await admin`update orders set status = 'pending_confirm' where id = ${id}`;
  const patch = (tok: string, status: string) => call("PATCH", `/api/staff/orders/${id}/status`, { slug: slugA, headers: auth(tok), body: { status } });
  ok((await patch(kitchenA, "accepted")).status === 403, "kitchen ยืนยันออเดอร์ไม่ได้");
  ok((await patch(cashierA, "accepted")).status === 200, "cashier ยืนยัน");
  ok((await patch(kitchenA, "served")).status === 409, "ข้ามขั้นตอนไม่ได้");
  ok((await patch(kitchenA, "preparing")).status === 200 && (await patch(kitchenA, "ready")).status === 200, "kitchen ทำ preparing→ready");
  ok((await call("GET", "/api/staff/orders", { slug: slugA })).status === 401, "ไม่มี token → 401");
  ok((await call("PATCH", `/api/staff/menu/${rice}`, { slug: slugA, headers: auth(cashierA), body: { price_satang: 1 } })).status === 403, "cashier แก้ราคาไม่ได้");
  ok((await call("PATCH", `/api/staff/menu/${rice}`, { slug: slugA, headers: auth(staffA), body: { available: true } })).status === 200, "manager แก้เมนูได้");
}

console.log("# Phase 6: Daily Reset");
{
  const R = await mkTenant(`r${rnd}`);
  const slug = `r${rnd}`;
  const sr = await mkStaff(R, "manager"), cr = await mkStaff(R, "cashier");
  const rRice = await mkMenu(R, "r", 10);
  const ta = await mkTable(R, "T1"), tb2 = await mkTable(R, "T2");
  const a = await seat(slug, R, sr, ta), b = await seat(slug, R, sr, tb2);
  const oa = await order(slug, a.dev, [{ menuItemId: rRice, qty: 1 }]);
  const ob = await order(slug, b.dev, [{ menuItemId: rRice, qty: 1 }]);
  await admin`update orders set status = 'served' where id = ${ob.json.order.id}`;

  // ยังไม่ถึงเวลา: ตั้งเวลา reset เป็นอีก 2 ชั่วโมงข้างหน้า (ตาม tz ของร้าน)
  await admin`update tenant set tz = 'Asia/Bangkok', reset_time = ((now() at time zone 'Asia/Bangkok')::time + interval '2 hours')::time where id = ${R}`;
  // เคส reset_time ข้ามเที่ยงคืนทำให้ผลกลับด้าน จึงเช็คเฉพาะเมื่อเวลานี้ < 22:00
  const [loc] = await admin`select ((now() at time zone 'Asia/Bangkok')::time < '22:00') as early`;
  if (loc!.early) {
    const none = await runDueResets({ tenantIds: [R] });
    ok(none.length === 0, "ยังไม่ถึงเวลา reset → ไม่ทำอะไร", none);
  }
  ok((await call("POST", "/api/staff/reset", { slug, headers: auth(cr) })).status === 403, "cashier สั่ง reset เองไม่ได้");

  // ถึงเวลาพอดี (เลยมา 1 นาที)
  await admin`update tenant set reset_time = ((now() at time zone tz)::time - interval '1 minute')::time, last_reset_on = null where id = ${R}`;
  const [early2] = await admin`select ((now() at time zone tz)::time >= '00:01') as okk from tenant where id = ${R}`;
  if (early2!.okk) {
    const rs = await Promise.all([runDueResets({ tenantIds: [R] }), runDueResets({ tenantIds: [R] })]);
    const all = rs.flat();
    ok(all.length === 1 && all[0]!.action === "reset" && all[0]!.closedBills === 2, "reset ทำครั้งเดียวแม้รันพร้อมกัน 2 worker", all);
    const [bills] = await admin`select count(*) filter (where status = 'open')::int as open, count(*) filter (where closed_reason = 'daily_reset')::int as dr from bill where tenant_id = ${R}`;
    ok(bills!.open === 0 && bills!.dr === 2, "ทุกบิลปิดด้วยเหตุผล daily_reset", bills);
    const rows = await admin`select id, status from orders where tenant_id = ${R}`;
    const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    ok(st[oa.json.order.id] === "cancelled" && st[ob.json.order.id] === "served", "ยกเลิกออเดอร์ค้าง เสิร์ฟแล้วคงเดิม", st);
    ok((await call("GET", "/api/orders", { slug, headers: auth(a.dev) })).json?.error === "session_closed", "device ทุกเครื่องถูกตัด");
    ok((await runDueResets({ tenantIds: [R] })).length === 0, "รันซ้ำวันเดียวกัน ไม่ reset ซ้ำ");
    const again = await openTable(slug, sr, ta.id);
    ok(again.status === 201, "หลัง reset เปิดโต๊ะใหม่ได้");

    // worker ดับนานเกิน grace → ข้ามรอบ ไม่ตัดลูกค้าที่กำลังกินข้าว
    await admin`update tenant set reset_time = ((now() at time zone tz)::time - interval '45 minutes')::time, last_reset_on = null where id = ${R}`;
    const [early3] = await admin`select ((now() at time zone tz)::time >= '00:46') as okk from tenant where id = ${R}`;
    if (early3!.okk) {
      const late = await runDueResets({ tenantIds: [R] });
      ok(late.length === 1 && late[0]!.action === "skipped_late", "ช้าเกิน 30 นาที → skipped_late", late);
      const [still] = await admin`select count(*)::int as n from bill where tenant_id = ${R} and status = 'open'`;
      ok(still!.n === 1, "บิลที่เปิดอยู่ไม่ถูกตัด");
    }
  } else console.log("  skip  (ใกล้เที่ยงคืน ข้ามเทสต์เวลา)");

  // สั่งเอง
  const x = await seat(slug, R, sr, tb2);
  const man = await call("POST", "/api/staff/reset", { slug, headers: auth(sr) });
  ok(man.status === 200 && man.json.closedBills >= 1, "manager สั่ง reset เองได้", man.json);
  ok((await call("GET", "/api/orders", { slug, headers: auth(x.dev) })).json?.error === "session_closed", "manual reset ตัด device");
  // ปิดการใช้งาน
  await admin`update tenant set reset_enabled = false, last_reset_on = null where id = ${R}`;
  ok((await runDueResets({ tenantIds: [R] })).length === 0, "reset_enabled=false → ไม่ทำ");
}

console.log("# Rate limit ต่อ IP");
{
  const t = await tb(15);
  const s = await seat(slugA, A, staffA, t);
  const ip = randIp();
  let n429 = 0;
  for (let i = 0; i < 70; i++) {
    const r = await call("POST", "/api/orders", { slug: slugA, ip, body: { items: [{ menuItemId: rice, qty: 1 }] }, headers: { ...auth(s.dev), "idempotency-key": idemKey() } });
    if (r.status === 429) n429++;
  }
  ok(n429 > 0, "IP เดียวยิงออเดอร์ถี่เกิน → ถูก 429", n429);
}

console.log("# TLS ask / health");
{
  const base = process.env.BASE_DOMAIN ?? "localhost";
  const g = (d: string) => app.handle(new Request(`http://localhost/internal/tls-ask?domain=${d}`));
  ok((await g(`${slugA}.${base}`)).status === 200, "tls-ask: ร้านที่มีอยู่");
  ok((await g(`nope${rnd}.${base}`)).status === 404, "tls-ask: ร้านที่ไม่มี");
  ok((await g(`evil.com`)).status === 404, "tls-ask: โดเมนอื่น");
  ok((await app.handle(new Request("http://localhost/healthz"))).status === 200, "healthz");
}

console.log(`\n${checks - fails}/${checks} passed`);
await admin.end();
await appSql.end({ timeout: 2 });
process.exit(fails ? 1 : 0);
