// Connector ↔ POS-Server ↔ FloCafe (จำลอง) — รูปแบบ request/response อ้างอิงจาก docs/reference/api.md ของ FloCafe
process.env.GUEST_QR_SECRET ??= "g".repeat(48);
process.env.DATABASE_URL ??= "postgres://pos_app:app_pw_test@127.0.0.1:5432/pos";
const ADMIN = process.env.ADMIN_DATABASE_URL ?? "postgres://pos_migrate:mig_pw_test@127.0.0.1:5432/pos";
import postgres from "postgres";
const { app } = await import("../src/api.ts");
const { tableToken, randomToken, sha256hex } = await import("../src/crypto.ts");
const { sql: appSql } = await import("../src/db.ts");
const { runOnce } = await import("../connector/flocafe.ts");

let checks = 0, fails = 0;
const ok = (c: unknown, n: string, x?: unknown) => { checks++; if (!c) { fails++; console.log("  FAIL", n, x !== undefined ? JSON.stringify(x) : ""); } else console.log("  ok  ", n); };

// ---- FloCafe จำลอง (Server App :3003) ----
let floItemSeq = 9000;
const floItem = (i: any) => ({ id: ++floItemSeq, status: "pending", ...i });
const flo = { logins: 0, validJwt: "jwt-1", orders: [] as any[], calls: [] as string[], idem: new Map<string, any>(), down: false };
const floSrv = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (flo.down) return new Response("down", { status: 503 });
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : null;
    if (u.pathname === "/api/auth/login") {
      flo.logins++; flo.validJwt = `jwt-${flo.logins}`;
      return Response.json(body.email === "server@shop" && body.password === "pw" ? { access_token: flo.validJwt } : { error: "Invalid credentials" }, { status: body.password === "pw" ? 200 : 401 });
    }
    if (req.headers.get("authorization") !== `Bearer ${flo.validJwt}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const key = req.headers.get("idempotency-key");
    if (req.method === "POST" && key && flo.idem.has(key)) return Response.json(flo.idem.get(key), { status: 201 });
    if (u.pathname === "/api/orders" && req.method === "POST") {
      flo.calls.push("create");
      if (body.table_id === 999) return Response.json({ error: "Table has an active order" }, { status: 409 });
      const o = { id: 500 + flo.orders.length + 1, type: body.type, table_id: body.table_id, items: body.items.map(floItem), status: "pending", bills: [{ payment_status: "unpaid" }] };
      flo.orders.push(o); const r = { order: o }; if (key) flo.idem.set(key, r);
      return Response.json(r, { status: 201 });
    }
    const m = u.pathname.match(/^\/api\/orders\/(\d+)\/items$/);
    if (m && req.method === "POST") {
      flo.calls.push("append");
      const o = flo.orders.find((x) => x.id === Number(m[1]));
      if (!o) return Response.json({ error: "not found" }, { status: 404 });
      o.items.push(...body.items.map(floItem)); const r = { order: o }; if (key) flo.idem.set(key, r);
      return Response.json(r, { status: 200 });
    }
    const g = u.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (g && req.method === "GET") {
      const o = flo.orders.find((x) => x.id === Number(g[1]));
      return o ? Response.json({ order: o }) : Response.json({ error: "Order not found" }, { status: 404 });
    }
    return Response.json({ error: "nf" }, { status: 404 });
  },
});

const admin = postgres(ADMIN, { max: 2, onnotice: () => {} });
app.listen({ hostname: "127.0.0.1", port: 0 });
const posPort = app.server!.port;
const rnd = Math.random().toString(36).slice(2, 8), slug = `k${rnd}`;
const [T] = await admin`insert into tenant (slug, name, settings) values (${slug}, 'K', ${admin.json({ order_cooldown_sec: 0, pos_forward: true } as any)}) returning id`;
const tid = T!.id as string;
const mkTable = async (label: string, posId: string | null) => (await admin`insert into dining_table (tenant_id, label, pos_table_id) values (${tid}, ${label}, ${posId}) returning id, qr_version`)[0]!;
const mkMenu = async (name: string, pid: string | null) => (await admin`insert into menu_item (tenant_id, name, price_satang, pos_product_id) values (${tid}, ${name}, 6000, ${pid}) returning id`)[0]!.id as string;
const rice = await mkMenu("ข้าวผัด", "12"), soup = await mkMenu("ต้มยำ", "34"), unmapped = await mkMenu("ไม่ผูก", null);
const t8 = await mkTable("T8", "8"), t9 = await mkTable("T9", null);
const tok = (role: string) => { const t = randomToken(); return admin`insert into staff_user (tenant_id, name, role, token_hash) values (${tid}, ${role}, ${role}, ${sha256hex(t)})`.then(() => t); };
const connTok = await tok("connector"), mgrTok = await tok("manager");

const pos = (method: string, path: string, o: { token?: string; body?: unknown } = {}) =>
  fetch(`http://127.0.0.1:${posPort}${path}`, {
    method,
    headers: { "x-tenant-slug": slug, "x-real-ip": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

const cfg = () => ({ posUrl: `http://127.0.0.1:${posPort}`, posToken: connTok, posDevSlug: slug, floUrl: `http://127.0.0.1:${flo.down ? floSrv.port : floSrv.port}`, floEmail: "server@shop", floPassword: "pw" });
async function seat(t: any) {
  const o = await pos("POST", `/api/staff/tables/${t.id}/open`, { token: mgrTok });
  const j = await pos("POST", "/api/session", { body: { token: tableToken(tid, t.id, t.qr_version) } });
  return { billId: o.json.billId as string, dev: j.json.device as string };
}
const order = (dev: string, items: any[]) => fetch(`http://127.0.0.1:${posPort}/api/orders`, { method: "POST", headers: { "x-tenant-slug": slug, "x-real-ip": "10.9.9.9", authorization: `Bearer ${dev}`, "content-type": "application/json", "idempotency-key": randomToken(16) }, body: JSON.stringify({ items }) }).then((r) => r.json() as Promise<any>);

console.log("# สิทธิ์ connector");
{
  ok((await pos("GET", "/api/connector/jobs")).status === 401, "ไม่มี token → 401");
  ok((await pos("GET", "/api/connector/jobs", { token: mgrTok })).status === 403, "manager เรียก connector ไม่ได้");
  ok((await pos("GET", "/api/staff/orders", { token: connTok })).status === 403, "connector เรียก endpoint พนักงานไม่ได้");
  ok((await pos("GET", "/api/connector/jobs", { token: connTok })).status === 200, "connector ดึงงานได้");
}

console.log("# ส่งออเดอร์เข้า FloCafe");
const s8 = await seat(t8);
const o1 = await order(s8.dev, [{ menuItemId: rice, qty: 2, note: "ไม่เผ็ด" }, { menuItemId: soup, qty: 1 }]);
const o2 = await order(s8.dev, [{ menuItemId: soup, qty: 1 }]);
{
  const r1 = await runOnce(cfg());
  ok(r1.sent === 1 && flo.calls.join() === "create", "รอบแรก: ส่งเฉพาะออเดอร์แรกของบิล (สร้างออเดอร์ใน POS)", { r1, calls: flo.calls });
  const [b] = await admin`select pos_order_id from bill where id = ${s8.billId}`;
  ok(b?.pos_order_id === "501", "เก็บ pos_order_id ไว้กับบิล", b);
  ok(flo.orders[0].type === "dine_in" && flo.orders[0].table_id === 8 && flo.orders[0].items[0].product_id === 12 && flo.orders[0].items[0].quantity === 2 && flo.orders[0].items[0].special_instructions === "ไม่เผ็ด", "payload: dine_in, table_id, product_id, quantity, note", flo.orders[0]);
  const r2 = await runOnce(cfg());
  ok(r2.sent === 1 && flo.calls.join() === "create,append" && flo.orders[0].items.length === 3, "รอบสอง: เพิ่มรายการเข้าออเดอร์เดิม ไม่สร้างใหม่", { calls: flo.calls });
  const n = (await admin`select count(*)::int as n from pos_forward where tenant_id = ${tid} and status = 'sent'`)[0]!.n;
  ok(n === 2, "ทั้งสองงานเป็น sent");
  ok((await runOnce(cfg())).sent === 0, "ไม่มีงานค้าง");
  const ids = await admin`select order_id, pos_item_ids from pos_forward where bill_id = ${s8.billId} order by id`;
  ok(ids[0]?.pos_item_ids.length === 2 && ids[1]?.pos_item_ids.length === 1, "เก็บ id รายการ FloCafe ของแต่ละออเดอร์", ids);
  ok(!ids[1]!.pos_item_ids.some((x: string) => ids[0]!.pos_item_ids.includes(x)), "ออเดอร์รอบสองได้เฉพาะรายการที่เพิ่งเพิ่ม");
}

console.log("# ข้อมูลไม่ครบ / ปัญหาชั่วคราว");
{
  const s9 = await seat(t9);
  await order(s9.dev, [{ menuItemId: rice, qty: 1 }]);
  const r = await runOnce(cfg());
  ok(r.failed === 1, "โต๊ะที่ไม่ได้ผูกกับ FloCafe → ล้มเหลวถาวร", r);
  const [f] = await admin`select status, last_error from pos_forward where bill_id = ${s9.billId}`;
  ok(f?.status === "failed" && f.last_error.includes("T9"), "บันทึกสาเหตุ (ชื่อโต๊ะ)", f);
  const s10 = await seat(await mkTable("T10", "10"));
  await order(s10.dev, [{ menuItemId: unmapped, qty: 1 }]);
  await runOnce(cfg());
  const [f2] = await admin`select status, last_error from pos_forward where bill_id = ${s10.billId}`;
  ok(f2?.status === "failed" && f2.last_error.includes("ไม่ผูก"), "สินค้าที่ไม่ได้ผูก → ล้มเหลวถาวร ระบุชื่อสินค้า");

  // FloCafe ล่ม → ลองใหม่ (ไม่ถาวร)
  const s11 = await seat(await mkTable("T11", "11"));
  await order(s11.dev, [{ menuItemId: rice, qty: 1 }]);
  flo.down = true;
  const rd = await runOnce(cfg()).catch((e) => ({ err: String(e) }));
  flo.down = false;
  const [pend] = await admin`select status, attempts from pos_forward where bill_id = ${s11.billId}`;
  ok(pend?.status === "pending" && pend.attempts >= 1, "FloCafe ล่ม: งานยัง pending (จะลองใหม่แบบ backoff)", { rd, pend });
  await admin`update pos_forward set lease_until = null where bill_id = ${s11.billId}`;
  ok((await runOnce(cfg())).sent === 1, "กลับมาแล้วส่งสำเร็จ");

  // JWT หมดอายุกลางทาง → login ใหม่เอง
  flo.validJwt = "expired-elsewhere";
  const s12 = await seat(await mkTable("T12", "12"));
  await order(s12.dev, [{ menuItemId: rice, qty: 1 }]);
  const before = flo.logins;
  ok((await runOnce(cfg())).sent === 1 && flo.logins > before, "401 จาก FloCafe → login ใหม่แล้วทำต่อ");

  // ส่งซ้ำด้วย Idempotency-Key เดิมไม่เกิดออเดอร์ซ้ำ (จำลองผลลัพธ์หายหลังส่งสำเร็จ)
  const s13 = await seat(await mkTable("T13", "13"));
  const ox = await order(s13.dev, [{ menuItemId: rice, qty: 1 }]);
  await runOnce(cfg());
  const count = flo.orders.length;
  await admin`update pos_forward set status = 'pending', sent_at = null, lease_until = null where order_id = ${ox.order.id}`;
  await admin`update bill set pos_order_id = null where id = ${s13.billId}`;
  await runOnce(cfg());
  ok(flo.orders.length === count, "ส่งซ้ำด้วย key เดิม FloCafe คืนผลเดิม ไม่สร้างออเดอร์ซ้ำ");
}

console.log("# สถานะจากครัว FloCafe → ลูกค้า");
{
  const bad = await pos("POST", `/api/connector/orders/${o1.order.id}/status`, { token: connTok, body: { status: "bogus" } });
  ok(bad.status === 422, "สถานะแปลก → 422");
  const status = async (id: string) => (await admin`select status from orders where id = ${id}`)[0]!.status;
  const fo = flo.orders[0];
  fo.items[0].status = "preparing";
  const r1 = await runOnce(cfg());
  ok(r1.statuses === 1 && (await status(o1.order.id)) === "preparing", "ครัวเริ่มทำ → ออเดอร์แรกเป็น preparing", r1);
  ok((await status(o2.order.id)) === "accepted", "ออเดอร์ที่สองยังไม่เริ่ม");
  fo.items[1].status = "ready";
  ok((await runOnce(cfg())).statuses === 0, "ยังเหลือรายการที่ทำอยู่ → ยังไม่ ready");
  fo.items[0].status = "served"; fo.items[1].status = "served";
  await runOnce(cfg());
  ok((await status(o1.order.id)) === "served", "เสิร์ฟครบ → served");
  fo.items[0].status = "preparing";
  await runOnce(cfg());
  ok((await status(o1.order.id)) === "served", "ไม่ถอยสถานะกลับ");
  fo.items[2].status = "cancelled";
  await runOnce(cfg());
  ok((await status(o2.order.id)) === "cancelled", "รายการถูกยกเลิกใน FloCafe → ออเดอร์ QR ยกเลิก");
}


console.log("# ชำระเงินใน FloCafe → ปิดบิล");
{
  const r0 = await runOnce(cfg());
  ok(r0.closed === 0, "ยังไม่ชำระ: ไม่ปิดบิล", r0);
  flo.orders[0].bills[0].payment_status = "paid";
  const r1 = await runOnce(cfg());
  ok(r1.closed >= 1, "FloCafe ชำระแล้ว → ปิดบิลฝั่งเรา", r1);
  const [b] = await admin`select status, closed_reason from bill where id = ${s8.billId}`;
  ok(b?.status === "closed" && b.closed_reason === "paid", "closed (paid)", b);
  const dead = await fetch(`http://127.0.0.1:${posPort}/api/orders`, { headers: { "x-tenant-slug": slug, "x-real-ip": "10.9.9.9", authorization: `Bearer ${s8.dev}` } });
  ok(dead.status === 401, "ลูกค้าถูกตัดทันที");
  const rep = await pos("POST", `/api/connector/bills/${s8.billId}/paid`, { token: connTok });
  ok(rep.status === 200 && rep.json.alreadyClosed === true, "แจ้งซ้ำได้ (idempotent)");
}

console.log("# ยกเลิกใน FloCafe → ปิดบิล");
{
  const s20 = await seat(await mkTable("T20", "20"));
  const oc = await order(s20.dev, [{ menuItemId: rice, qty: 1 }]);
  await runOnce(cfg());
  const fo = flo.orders[flo.orders.length - 1];
  fo.status = "cancelled"; fo.cancellation_reason = "Merged into ORD-9";
  await runOnce(cfg());
  ok((await admin`select status from bill where id = ${s20.billId}`)[0]!.status === "open", "รวมโต๊ะ (ยกเลิกออเดอร์ต้นทาง) ไม่ปิดบิลลูกค้า");
  fo.cancellation_reason = "Customer left";
  const r = await runOnce(cfg());
  ok(r.cancelled === 1, "ออเดอร์ถูกยกเลิก → ยกเลิกบิล", r);
  const [b] = await admin`select status, closed_reason from bill where id = ${s20.billId}`;
  ok(b?.status === "closed" && b.closed_reason === "cancelled", "closed (cancelled)", b);
  ok((await admin`select status from orders where id = ${oc.order.id}`)[0]!.status === "cancelled", "ออเดอร์ที่ยังไม่เสิร์ฟถูกยกเลิก");
  const rep = await pos("POST", `/api/connector/bills/${s20.billId}/cancelled`, { token: connTok });
  ok(rep.status === 200 && rep.json.alreadyClosed === true, "แจ้งซ้ำได้ (idempotent)");
}


console.log(`\n${checks - fails}/${checks} passed`);
await app.stop(); floSrv.stop(true); await admin.end(); await appSql.end({ timeout: 2 });
process.exit(fails ? 1 : 0);
