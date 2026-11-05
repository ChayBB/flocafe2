// หน้าสั่งอาหารของลูกค้า (ตัวอย่างขั้นต่ำ ใช้ทดสอบ flow จริงกับ API)
// ประเด็นสำคัญ: Idempotency-Key สร้างตอนกดสั่งครั้งแรกและใช้ซ้ำเมื่อ retry จนกว่าจะสำเร็จหรือตะกร้าเปลี่ยน
const $ = (s) => document.querySelector(s);
const money = (satang) => (satang / 100).toLocaleString("th-TH", { style: "currency", currency: "THB" });
const STATUS = {
  pending_confirm: "รอพนักงานยืนยัน",
  accepted: "รับออเดอร์แล้ว",
  preparing: "กำลังทำ",
  ready: "พร้อมเสิร์ฟ",
  served: "เสิร์ฟแล้ว",
  cancelled: "ยกเลิก",
};
const ERRORS = {
  rate_limited: "ทำรายการถี่เกินไป กรุณารอสักครู่",
  item_unavailable: "มีรายการที่หมดแล้ว กรุณาเลือกใหม่",
  too_many_items: "จำนวนมากเกินไปต่อครั้ง กรุณาแยกเป็นหลายออเดอร์",
  session_invalid: "หมดเวลา กรุณาสแกน QR ที่โต๊ะอีกครั้ง",
  session_closed: "โต๊ะนี้ปิดบิลแล้ว หากต้องการสั่งเพิ่มกรุณาแจ้งพนักงาน",
  invalid_qr: "QR ไม่ถูกต้อง",
  table_not_open: "โต๊ะยังไม่เปิด กรุณาแจ้งพนักงานให้เปิดโต๊ะ แล้วสแกน QR อีกครั้ง",
  too_many_devices: "โต๊ะนี้มีผู้เข้าร่วมเต็มแล้ว",
  invite_invalid: "QR ชวนเพื่อนหมดอายุหรือใช้ไม่ได้ ขอให้เพื่อนสร้างใหม่",
  order_cooldown: "สั่งถี่เกินไป กรุณารอสักครู่",
  order_token_invalid: "ส่งไม่สำเร็จ กรุณากดสั่งอีกครั้ง",
  order_quota_exceeded: "ครบจำนวนออเดอร์สูงสุดของบิลนี้แล้ว กรุณาแจ้งพนักงาน",
};

const state = { device: null, orderToken: false, canInvite: false, menu: [], cart: new Map(), idem: null, busy: false, poll: null };

// localStorage: ปิดแท็บ/เน็ตหลุด/รีเฟรชแล้วกลับมาใช้ session เดิมได้ (บิลปิดเมื่อไรเซิร์ฟเวอร์ตัดและเราล้างค่าเอง)
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// รหัสสุ่มประจำเครื่อง ใช้จำเครื่องเดิมเมื่อสแกนซ้ำ (เซิร์ฟเวอร์เก็บเฉพาะ hash)
function clientId() {
  let id = store.get("cid");
  if (!id) { id = crypto.randomUUID().replaceAll("-", "") + "x"; store.set("cid", id); }
  return id;
}
const say = (t) => { $("#msg").textContent = t || ""; };

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (state.device) h.authorization = "Bearer " + state.device;
  if (body) h["content-type"] = "application/json";
  const res = await fetch("/api" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "session_closed" || data.error === "session_invalid") endSession(data.error);
    throw Object.assign(new Error(data.error || String(res.status)), { status: res.status, data });
  }
  return data;
}

// บิลถูกปิด/ย้ายโต๊ะ/รีเซ็ต → ล้างสิทธิ์ทันทีและหยุด polling
function endSession(reason) {
  state.device = null;
  store.set("s", null);
  clearInterval(state.poll);
  $("#menu").replaceChildren();
  $("#cartbar").hidden = true;
  $("#invite").hidden = true;
  say(ERRORS[reason] || ERRORS.session_invalid);
}

function setDevice(s) {
  state.device = s.device;
  state.canInvite = !!s.canInvite;
  state.orderToken = !!s.orderToken;
  store.set("s", { device: s.device, canInvite: state.canInvite, orderToken: state.orderToken, table: s.table, shop: s.tenant?.name });
  $("#shop").textContent = s.tenant?.name || "สั่งอาหาร";
  $("#table").textContent = "โต๊ะ " + s.table.label;
}

async function start() {
  const t = location.pathname.match(/^\/t\/([^/]+)$/);
  const j = location.pathname.match(/^\/j\/([^/]+)$/);
  if (t) {
    const token = decodeURIComponent(t[1]);
    history.replaceState(null, "", "/"); // ไม่ให้ token ค้างใน URL / history / Referer
    setDevice(await api("/session", { method: "POST", body: { token, clientId: clientId() } }));
  } else if (j) {
    const code = decodeURIComponent(j[1]);
    history.replaceState(null, "", "/");
    setDevice(await api("/session/join", { method: "POST", body: { code } }));
  } else {
    const saved = store.get("s");
    if (!saved) {
      throw Object.assign(new Error("session_invalid"), { data: { error: "session_invalid" } });
    } else {
      state.device = saved.device; state.canInvite = saved.canInvite; state.orderToken = !!saved.orderToken;
      $("#shop").textContent = saved.shop || "สั่งอาหาร";
      $("#table").textContent = "โต๊ะ " + saved.table.label;
      await api("/session"); // ตรวจว่ายังใช้ได้ (ถ้าบิลปิดแล้วจะเข้า endSession)
    }
  }
  $("#invite").hidden = !state.canInvite;
  const { items } = await api("/menu");
  state.menu = items;
  renderMenu();
  refreshOrders();
  state.poll = setInterval(refreshOrders, 5000);
}

// ชวนเพื่อนร่วมโต๊ะ: QR ชั่วคราว 5 นาที (วาดฝั่ง client ไม่ส่ง code ไปบริการภายนอก)
async function invite() {
  const box = $("#invitebox");
  try {
    const r = await api("/session/invite", { method: "POST" });
    const q = qrcode(0, "M");
    q.addData(r.url); q.make();
    box.hidden = false;
    box.replaceChildren();
    const img = document.createElement("img");
    img.alt = "QR ชวนเพื่อน"; img.width = 220; img.height = 220;
    img.src = q.createDataURL(6, 4);
    const note = document.createElement("div");
    note.className = "muted";
    const left = () => Math.max(0, Math.round((new Date(r.expiresAt) - Date.now()) / 1000));
    const tick = () => { note.textContent = left() ? `ให้เพื่อนสแกน (หมดอายุใน ${Math.floor(left() / 60)}:${String(left() % 60).padStart(2, "0")})` : "QR หมดอายุแล้ว กดชวนเพื่อนอีกครั้ง"; if (!left()) { clearInterval(timer); img.remove(); } };
    const timer = setInterval(tick, 1000);
    tick();
    box.append(img, note);
  } catch (e) {
    say(ERRORS[e.data?.error] || "สร้าง QR ไม่สำเร็จ");
  }
}

function renderMenu() {
  const box = $("#menu");
  box.replaceChildren();
  for (const it of state.menu) {
    const row = document.createElement("div");
    row.className = "item";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = it.name; // textContent เสมอ ไม่ใช้ innerHTML กับข้อมูลจากเซิร์ฟเวอร์
    const price = document.createElement("div");
    price.className = "muted";
    price.textContent = money(it.price_satang);
    info.append(name, price);
    const qty = document.createElement("div");
    qty.className = "qty";
    const minus = document.createElement("button");
    minus.type = "button"; minus.textContent = "−"; minus.setAttribute("aria-label", "ลด " + it.name);
    const n = document.createElement("span");
    n.dataset.id = it.id; n.textContent = String(state.cart.get(it.id) || 0);
    const plus = document.createElement("button");
    plus.type = "button"; plus.textContent = "+"; plus.setAttribute("aria-label", "เพิ่ม " + it.name);
    minus.onclick = () => setQty(it.id, (state.cart.get(it.id) || 0) - 1);
    plus.onclick = () => setQty(it.id, (state.cart.get(it.id) || 0) + 1);
    qty.append(minus, n, plus);
    row.append(info, qty);
    box.append(row);
  }
}

function setQty(id, q) {
  q = Math.max(0, Math.min(20, q));
  if (q === 0) state.cart.delete(id); else state.cart.set(id, q);
  state.idem = null; // ตะกร้าเปลี่ยน → ต้องใช้ key ใหม่ (key เดิมผูกกับ payload เดิม)
  const span = document.querySelector(`[data-id="${id}"]`);
  if (span) span.textContent = String(q);
  renderCart();
}

function renderCart() {
  let count = 0, total = 0;
  for (const [id, q] of state.cart) {
    const it = state.menu.find((m) => m.id === id);
    if (!it) continue;
    count += q; total += q * it.price_satang;
  }
  $("#cartbar").hidden = count === 0;
  $("#count").textContent = count + " รายการ";
  $("#total").textContent = money(total);
}

async function submit() {
  if (state.busy || state.cart.size === 0) return;
  state.busy = true; $("#submit").disabled = true; say("");
  state.idem ??= crypto.randomUUID().replaceAll("-", "") + "x"; // 33 ตัว ผ่านเงื่อนไข 16–64
  const items = [...state.cart].map(([menuItemId, qty]) => ({ menuItemId, qty }));
  try {
    const headers = { "idempotency-key": state.idem };
    if (state.orderToken) headers["x-order-token"] = (await api("/orders/token", { method: "POST" })).orderToken; // ใช้ครั้งเดียว ขอใหม่ทุกครั้งที่ส่ง
    await api("/orders", { method: "POST", body: { items }, headers });
    state.cart.clear(); state.idem = null;
    renderMenu(); renderCart(); say("ส่งออเดอร์แล้ว");
    refreshOrders();
  } catch (e) {
    // เครือข่ายหลุด/timeout: เก็บ key เดิมไว้ กดซ้ำจะไม่ได้ออเดอร์ซ้ำ
    if (e.data?.error === "order_cooldown" || e.data?.error === "order_quota_exceeded") { /* คง key เดิมไว้ ลองใหม่ได้ */ }
    if (e.status === 409 && e.data?.error === "item_unavailable") { state.idem = null; const m = await api("/menu"); state.menu = m.items; state.cart.clear(); renderMenu(); renderCart(); }
    say(ERRORS[e.data?.error] || "ส่งไม่สำเร็จ กรุณากดสั่งอีกครั้ง");
  } finally {
    state.busy = false; $("#submit").disabled = false;
  }
}

async function refreshOrders() {
  try {
    const { orders } = await api("/orders");
    const box = $("#orders");
    box.replaceChildren();
    if (!orders.length) return;
    const h = document.createElement("h2");
    h.textContent = "ออเดอร์ของโต๊ะนี้";
    box.append(h);
    for (const o of orders) {
      const d = document.createElement("div");
      d.className = "order";
      const lines = document.createElement("div");
      lines.textContent = o.items.map((i) => `${i.name} ×${i.qty}`).join(", ");
      const st = document.createElement("div");
      st.className = "status";
      st.textContent = `${STATUS[o.status] || o.status} · ${money(o.total_satang)}`;
      d.append(lines, st);
      box.append(d);
    }
  } catch { /* ลองใหม่รอบถัดไป */ }
}

$("#submit").onclick = submit;
$("#invite").onclick = invite;
start().catch((e) => say(ERRORS[e.data?.error] || "เปิดหน้าไม่ได้ กรุณาสแกน QR ที่โต๊ะอีกครั้ง"));
