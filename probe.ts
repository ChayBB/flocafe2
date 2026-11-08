// ตรวจ FloCafe ตัวจริงแบบอ่านอย่างเดียว (ไม่สร้าง/แก้ข้อมูลใด ๆ): ล็อกอิน → ดึงโต๊ะ/สินค้า/ออเดอร์
// แล้วพิมพ์ (1) โครงฟิลด์ที่ connector ต้องใช้ (2) คำสั่ง pos-admin set-pos-map ที่จับคู่ตามชื่อ
//   FLO_URL=http://<เครื่อง FloCafe>:3003 FLO_EMAIL=... FLO_PASSWORD=... bun run connector/probe.ts [slug]
// ข้อมูลส่วนตัว (ชื่อลูกค้า/เบอร์) ไม่ถูกพิมพ์ — แสดงเฉพาะชื่อฟิลด์และค่าสถานะ
const url = (process.env.FLO_URL ?? 'http://127.0.0.1:3003').replace(/\/$/, '');
const slug = process.argv[2] ?? '<slug>';
const bad = (m: string): never => {
  console.error('✗ ' + m);
  process.exit(1);
};

const lg = await fetch(url + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.FLO_EMAIL, password: process.env.FLO_PASSWORD }),
}).catch((e) => bad(`ต่อ ${url} ไม่ได้: ${e}`));
if (!lg.ok) bad(`login ล้มเหลว ${lg.status} ${await lg.text()}`);
const jwt = ((await lg.json()) as any).access_token as string;
console.log('✓ login สำเร็จ (Server App :3003)');
const get = async (p: string) => {
  const r = await fetch(url + p, { headers: { authorization: `Bearer ${jwt}` } });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

const keys = (o: any) =>
  o && typeof o === 'object' ? Object.keys(o).sort().join(', ') : String(o);
const arr = (j: any, k: string): any[] =>
  Array.isArray(j) ? j : Array.isArray(j?.[k]) ? j[k] : [];

const tb = await get('/api/tables');
const tables = arr(tb.json, 'tables');
console.log(`\nGET /api/tables → ${tb.status}, ${tables.length} โต๊ะ`);
console.log('  ฟิลด์:', keys(tables[0]));

const pr = await get('/api/products');
const products = arr(pr.json, 'products');
console.log(`GET /api/products → ${pr.status}, ${products.length} สินค้า`);
console.log('  ฟิลด์:', keys(products[0]));

const od = await get('/api/orders?view=all&per_page=5');
const orders = arr(od.json, 'orders');
console.log(`GET /api/orders → ${od.status}, ตัวอย่าง ${orders.length} ออเดอร์`);
console.log('  ฟิลด์ระดับออเดอร์:', keys(orders[0]));
for (const o of orders.slice(0, 5)) {
  console.log(
    '  -',
    JSON.stringify({
      id: o.id,
      type: o.type,
      status: o.status,
      table_id: o.table_id,
      bill_payment_status: o.bill_payment_status,
      bills: Array.isArray(o.bills) ? o.bills.map((b: any) => b.payment_status) : undefined,
    }),
  );
}
const paid = orders.find(
  (o) =>
    o.bill_payment_status === 'paid' ||
    (o.bills ?? []).some((b: any) => b.payment_status === 'paid'),
);
console.log(
  paid
    ? "✓ เจอออเดอร์ที่ชำระแล้ว: ฟิลด์ที่ใช้ตรวจ 'ชำระแล้ว' ถูกต้อง"
    : '• ยังไม่เจอออเดอร์ที่ชำระแล้วในตัวอย่าง — ให้ชำระสักออเดอร์แล้วรันใหม่เพื่อยืนยันฟิลด์',
);

// จับคู่ตามชื่อ: โต๊ะ (label/number/name) และสินค้า (name)
const norm = (s: any) =>
  String(s ?? '')
    .trim()
    .toLowerCase();
console.log('\n# คำสั่งผูก id (ตรวจชื่อโต๊ะ/เมนูฝั่งเราให้ตรงก่อนรัน; แก้ <ชื่อ> ถ้าไม่ตรง)');
for (const t of tables)
  console.log(
    `pos-admin set-pos-map ${slug} table "${t.name ?? t.number}" ${t.id}   # number=${t.number ?? '-'} floor=${t.floor ?? '-'}`,
  );
for (const p of products)
  console.log(
    `pos-admin set-pos-map ${slug} menu "${String(p.name).replaceAll('"', '\\"')}" ${p.id}`,
  );
void norm;
