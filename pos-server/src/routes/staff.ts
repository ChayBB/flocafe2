import { Elysia, t } from "elysia";
import { config } from "../config.ts";
import { enqueue, notify, withTenant, type Tx } from "../db.ts";
import { sha256hex } from "../crypto.ts";
import { HttpError, bearer, reqCtx } from "../http.ts";
import { dbLimit } from "../ratelimit.ts";
import { menuCache } from "../cache.ts";
import { sseResponse } from "../events.ts";
import { cancelUnservedOrders, closeBill, openBill, rotateOpenBill } from "../sessions.ts";
import { resetTenant } from "../reset.ts";
import type { Tenant } from "../db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Role = "kitchen" | "cashier" | "manager" | "connector";
type Status = "pending_confirm" | "accepted" | "preparing" | "ready" | "served" | "cancelled";

const TRANSITIONS: Record<Status, Status[]> = {
  pending_confirm: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "cancelled"],
  served: [],
  cancelled: [],
};

// kitchen ทำได้เฉพาะขั้นตอนในครัว; ยืนยัน/ยกเลิกเป็นของ cashier/manager
const KITCHEN_TARGETS: Status[] = ["preparing", "ready", "served"];

/** token ของ connector ใช้ได้เฉพาะ /api/connector/* — ห้ามเรียก endpoint พนักงานอื่น */
async function staffAuth(request: Request, ip: string, tenant: Tenant): Promise<{ id: string; role: Role }> {
  const u = await anyStaffAuth(request, ip, tenant);
  if (u.role === "connector") throw new HttpError(403, "forbidden");
  return u;
}

export async function anyStaffAuth(request: Request, ip: string, tenant: Tenant): Promise<{ id: string; role: Role }> {
  const tok = bearer(request);
  const fail = async () => {
    if (!(await dbLimit(`staff-fail:${ip}`, config.limits.staffFailPerIp10m, 600))) throw new HttpError(429, "rate_limited");
    throw new HttpError(401, "unauthorized");
  };
  if (!tok || tok.length > 128) return fail();
  const [u] = await withTenant(
    tenant.id,
    (tx) => tx`select id, role from staff_user where token_hash = ${sha256hex(tok)} and active`,
  );
  if (!u) return fail();
  return { id: u.id, role: u.role as Role };
}

function requireRole(role: Role, ...allowed: Role[]) {
  if (!allowed.includes(role)) throw new HttpError(403, "forbidden");
}

const ITEMS = (tx: Tx) => tx`
  coalesce(json_agg(json_build_object('name', i.name_snapshot, 'qty', i.qty, 'note', i.note) order by i.id)
           filter (where i.id is not null), '[]') as items`;

/** lock บิลที่เปิดอยู่ (ลำดับ lock เดียวกับตอนลูกค้าสั่ง: บิลก่อนเสมอ) */
async function lockOpenBill(tx: Tx, billId: string) {
  if (!UUID.test(billId)) throw new HttpError(404, "not_found");
  const [b] = await tx`select id, table_id from bill where id = ${billId} and status = 'open' for update`;
  if (!b) throw new HttpError(404, "not_found");
  return b as { id: string; table_id: string };
}

export const staff = new Elysia({ prefix: "/api/staff" })
  // ---------------- KDS / ออเดอร์ ----------------
  .get("/orders", async ({ request }) => {
    const { ip, tenant } = await reqCtx(request);
    await staffAuth(request, ip, tenant);
    const orders = await withTenant(
      tenant.id,
      (tx) => tx`
        select o.id, o.status, o.total_satang, o.note, o.created_at, t.label as table_label, ${ITEMS(tx)}
        from orders o
        join bill b on b.id = o.bill_id
        join dining_table t on t.id = b.table_id
        left join order_item i on i.order_id = o.id
        where o.status in ('pending_confirm', 'accepted', 'preparing', 'ready')
        group by o.id, t.label order by o.created_at`,
    );
    return { orders };
  })

  .patch(
    "/orders/:id/status",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
      const to = body.status as Status;
      if (me.role === "kitchen" && !KITCHEN_TARGETS.includes(to)) throw new HttpError(403, "forbidden");

      return withTenant(tenant.id, async (tx) => {
        const [cur] = await tx`select status, bill_id from orders where id = ${params.id} for update`;
        if (!cur) throw new HttpError(404, "not_found");
        if (!TRANSITIONS[cur.status as Status].includes(to))
          throw new HttpError(409, "invalid_transition", { from: cur.status, to });
        await tx`update orders set status = ${to}, updated_at = now() where id = ${params.id}`;
        await enqueue(tx, tenant.id, "order.status", { orderId: params.id, from: cur.status, to, by: me.id });
        await notify(tx, tenant.id, "order.status", { id: params.id, billId: cur.bill_id });
        return { id: params.id, status: to };
      });
    },
    {
      body: t.Object({
        status: t.Union([
          t.Literal("accepted"),
          t.Literal("preparing"),
          t.Literal("ready"),
          t.Literal("served"),
          t.Literal("cancelled"),
        ]),
      }),
    },
  )

  // SSE (ใช้ fetch stream + header Authorization เพราะ EventSource ใส่ header ไม่ได้)
  .get("/events", async ({ request }) => {
    const { ip, tenant } = await reqCtx(request);
    await staffAuth(request, ip, tenant);
    return sseResponse(tenant.id, request);
  })

  .patch(
    "/menu/:id",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
      if (body.price_satang !== undefined) requireRole(me.role, "manager");
      if (body.available === undefined && body.price_satang === undefined) throw new HttpError(400, "nothing_to_update");
      const row = await withTenant(tenant.id, async (tx) => {
        const [r] = await tx`
          update menu_item set
            available = coalesce(${body.available ?? null}, available),
            price_satang = coalesce(${body.price_satang ?? null}, price_satang)
          where id = ${params.id}
          returning id, name, price_satang, available`;
        if (!r) throw new HttpError(404, "not_found");
        await notify(tx, tenant.id, "menu.changed", { id: params.id });
        return r;
      });
      menuCache.delete(tenant.id);
      return row;
    },
    {
      body: t.Object({
        available: t.Optional(t.Boolean()),
        price_satang: t.Optional(t.Integer({ minimum: 0, maximum: 99_999_999 })),
      }),
    },
  )

  // ---------------- Phase 6: โต๊ะ / บิล (session) ----------------
  // รายการโต๊ะ + บิลที่เปิดอยู่ (ใช้ดูว่าโต๊ะไหนเปิดแล้ว)
  .get("/tables", async ({ request }) => {
    const { ip, tenant } = await reqCtx(request);
    const me = await staffAuth(request, ip, tenant);
    requireRole(me.role, "cashier", "manager");
    const tables = await withTenant(
      tenant.id,
      (tx) => tx`
        select t.id, t.label, t.active, t.epoch, b.id as bill_id, b.opened_at,
               (select count(*)::int from guest_device d where d.bill_id = b.id and d.revoked_at is null) as devices
        from dining_table t
        left join bill b on b.table_id = t.id and b.status = 'open'
        order by t.label`,
    );
    return { tables };
  })

  // เปิดโต๊ะ → สร้างบิล (session) ลูกค้าสแกน QR แล้วเข้าได้ทันที
  .post("/tables/:id/open", async ({ request, params, set }) => {
    const { ip, tenant } = await reqCtx(request);
    const me = await staffAuth(request, ip, tenant);
    requireRole(me.role, "cashier", "manager");
    if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
    const r = await withTenant(tenant.id, async (tx) => {
      const [tb] = await tx`select id, label, active from dining_table where id = ${params.id}`;
      if (!tb || !tb.active) throw new HttpError(404, "not_found");
      const bill = await openBill(tx, tenant.id, tb.id, me.id);
      if (!bill) throw new HttpError(409, "already_open");
      await enqueue(tx, tenant.id, "bill.opened", { billId: bill.id, tableId: tb.id });
      return { billId: bill.id, table: tb.label };
    });
    set.status = 201;
    return r;
  })

  .get("/bills", async ({ request }) => {
    const { ip, tenant } = await reqCtx(request);
    const me = await staffAuth(request, ip, tenant);
    requireRole(me.role, "cashier", "manager");
    const bills = await withTenant(
      tenant.id,
      (tx) => tx`
        select b.id, t.label as table_label, b.opened_at,
               coalesce(sum(o.total_satang) filter (where o.status <> 'cancelled'), 0)::int as total_satang
        from bill b
        join dining_table t on t.id = b.table_id
        left join orders o on o.bill_id = b.id
        where b.status = 'open'
        group by b.id, t.label order by b.opened_at`,
    );
    return { bills };
  })

  // ปิดบิลเมื่อชำระเงินแล้ว: status = closed และตัดทุก device ทันที
  .post(
    "/bills/:id/close",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      requireRole(me.role, "cashier", "manager");
      return withTenant(tenant.id, async (tx) => {
        await lockOpenBill(tx, params.id);
        if (!body?.force) {
          const open = (await tx`
            select count(*)::int as n from orders
            where bill_id = ${params.id} and status in ('pending_confirm', 'accepted', 'preparing', 'ready')`)[0]!.n;
          if (open > 0) throw new HttpError(409, "orders_in_progress", { count: open });
        }
        const total = (await tx`
          select coalesce(sum(total_satang) filter (where status <> 'cancelled'), 0)::int as total
          from orders where bill_id = ${params.id}`)[0]!.total;
        await closeBill(tx, tenant.id, params.id, "paid", null, me.id);
        return { id: params.id, total_satang: total };
      });
    },
    { body: t.Optional(t.Object({ force: t.Optional(t.Boolean()) })) },
  )

  // ย้ายโต๊ะ: ปิด session เก่า (reason=moved) แล้วเปิด session ใหม่ที่โต๊ะใหม่ ออเดอร์/ยอดย้ายตามไปด้วย
  .post(
    "/bills/:id/move",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      requireRole(me.role, "cashier", "manager");
      return withTenant(tenant.id, async (tx) => {
        const old = await lockOpenBill(tx, params.id);
        const [to] = await tx`select id, label, active from dining_table where id = ${body.toTableId}`;
        if (!to || !to.active) throw new HttpError(404, "target_table_not_found");
        if (to.id === old.table_id) throw new HttpError(422, "same_table");
        const nb = await openBill(tx, tenant.id, to.id, me.id);
        if (!nb) throw new HttpError(409, "target_occupied");
        await tx`update orders set bill_id = ${nb.id}, updated_at = now() where bill_id = ${old.id}`;
        await closeBill(tx, tenant.id, old.id, "moved", nb.id, me.id);
        await enqueue(tx, tenant.id, "bill.moved", { fromBillId: old.id, toBillId: nb.id, toTableId: to.id });
        // KDS แสดงชื่อโต๊ะจากบิล → แจ้งให้รีเฟรช
        await notify(tx, tenant.id, "bill.moved", { id: nb.id, billId: nb.id });
        return { billId: nb.id, table: to.label };
      });
    },
    { body: t.Object({ toTableId: t.String({ pattern: "^[0-9a-fA-F-]{36}$" }) }) },
  )

  // ยกเลิกบิล: ยกเลิกออเดอร์ที่ยังไม่เสิร์ฟ ปิด session (ตัดทุก device) ถ้า reopen=true เปิด session ใหม่ที่โต๊ะเดิม
  .post(
    "/bills/:id/cancel",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      requireRole(me.role, "cashier", "manager");
      return withTenant(tenant.id, async (tx) => {
        const bill = await lockOpenBill(tx, params.id);
        const cancelled = await cancelUnservedOrders(tx, tenant.id, bill.id);
        await closeBill(tx, tenant.id, bill.id, "cancelled", null, me.id);
        await enqueue(tx, tenant.id, "bill.cancelled", {
          billId: bill.id,
          cancelledOrderIds: cancelled,
          reason: body?.reason ?? null,
          by: me.id,
        });
        let reopened: { billId: string } | null = null;
        if (body?.reopen) {
          const nb = await openBill(tx, tenant.id, bill.table_id, me.id);
          if (nb) reopened = { billId: nb.id };
        }
        return { id: bill.id, cancelledOrders: cancelled.length, reopened };
      });
    },
    {
      body: t.Optional(
        t.Object({ reopen: t.Optional(t.Boolean()), reason: t.Optional(t.String({ maxLength: 100 })) }),
      ),
    },
  )

  // หมุนรหัสโต๊ะเอง (สงสัยว่ามีคนถ่ายลิงก์/ส่งต่อ): ตัดทุกเครื่องของบิลที่เปิดอยู่ ลูกค้าตัวจริงสแกน QR เข้าใหม่
  .post(
    "/bills/:id/rotate",
    async ({ request, params, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const me = await staffAuth(request, ip, tenant);
      requireRole(me.role, "cashier", "manager");
      return withTenant(tenant.id, async (tx) => {
        const bill = await lockOpenBill(tx, params.id);
        const epoch = await rotateOpenBill(tx, tenant.id, bill.id, bill.table_id, me.id, body?.reason ?? null);
        return { id: bill.id, epoch };
      });
    },
    { body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 100 })) })) },
  )

  // ประวัติการหมุนรหัสของโต๊ะ
  .get("/tables/:id/audit", async ({ request, params }) => {
    const { ip, tenant } = await reqCtx(request);
    const me = await staffAuth(request, ip, tenant);
    requireRole(me.role, "manager");
    if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
    const rows = await withTenant(
      tenant.id,
      (tx) => tx`select epoch, action, reason, bill_id, actor, at from table_audit where table_id = ${params.id} order by id desc limit 100`,
    );
    return { audit: rows };
  })

  // Daily Reset แบบสั่งเอง (ตัวอัตโนมัติรันใน worker ตามเวลาของร้าน)
  .post("/reset", async ({ request }) => {
    const { ip, tenant } = await reqCtx(request);
    const me = await staffAuth(request, ip, tenant);
    requireRole(me.role, "manager");
    return withTenant(tenant.id, (tx) => resetTenant(tx, tenant.id));
  });
