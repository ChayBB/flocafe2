import { Elysia, t } from "elysia";
import { enqueue, notify, withTenant } from "../db.ts";
import { HttpError, reqCtx } from "../http.ts";
import { anyStaffAuth } from "./staff.ts";
import { closeBill } from "../sessions.ts";

const LEASE_SEC = 60;
const MAX_ATTEMPTS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAP_STATUS = { accepted: 1, preparing: 1, ready: 1, served: 1, cancelled: 1 } as const;

async function connectorAuth(request: Request) {
  const { ip, tenant } = await reqCtx(request);
  const me = await anyStaffAuth(request, ip, tenant);
  if (me.role !== "connector") throw new HttpError(403, "forbidden");
  return { tenant, me };
}

/**
 * Connector ในร้านดึงงานออกไปทำ (HTTPS ขาออกอย่างเดียว) แล้วรายงานผลกลับ
 * 1) GET jobs → ออเดอร์ที่ต้องส่งเข้า POS ในร้าน (lease 60 วินาที กันหลาย connector แย่งกัน)
 * 2) POST jobs/:id/result → สำเร็จ(เก็บ pos_order_id ของบิล) หรือล้มเหลว(ลองใหม่แบบ backoff)
 * 3) POST orders/:id/status / bills/:id/paid → POS ในร้านแจ้งความคืบหน้า/ชำระเงินแล้ว
 */
export const connector = new Elysia({ prefix: "/api/connector" })
  .get("/jobs", async ({ request }) => {
    const { tenant } = await connectorAuth(request);
    const jobs = await withTenant(tenant.id, async (tx) => {
      const rows = await tx`
        update pos_forward f set lease_until = now() + make_interval(secs => ${LEASE_SEC}), attempts = attempts + 1
        where f.id in (
          select id from pos_forward
          where status = 'pending' and attempts < ${MAX_ATTEMPTS} and (lease_until is null or lease_until < now())
            -- บิลเดียวกันส่งทีละรายการตามลำดับ: ออเดอร์แรกสร้างออเดอร์ใน POS แล้วรอบถัดไปค่อยเพิ่มเข้าไป
            and not exists (select 1 from pos_forward p where p.bill_id = pos_forward.bill_id and p.id < pos_forward.id and p.status = 'pending')
          order by id limit 10 for update skip locked)
        returning f.id, f.order_id, f.bill_id`;
      const out = [];
      for (const r of rows) {
        const [o] = await tx`
          select o.id, o.note, b.pos_order_id, t.label as table_label, t.pos_table_id
          from orders o join bill b on b.id = o.bill_id join dining_table t on t.id = b.table_id
          where o.id = ${r.order_id}`;
        const items = await tx`
          select i.qty, i.note, i.name_snapshot, m.pos_product_id
          from order_item i left join menu_item m on m.id = i.menu_item_id
          where i.order_id = ${r.order_id} order by i.id`;
        out.push({
          jobId: String(r.id),
          orderId: r.order_id,
          billId: r.bill_id,
          posOrderId: o?.pos_order_id ?? null, // มีค่า = เพิ่มรายการเข้าออเดอร์เดิม ไม่มี = สร้างออเดอร์ใหม่
          table: { label: o?.table_label, posTableId: o?.pos_table_id ?? null },
          note: o?.note ?? null,
          items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, note: i.note, posProductId: i.pos_product_id ?? null })),
        });
      }
      return out;
    });
    return { jobs };
  })

  .post(
    "/jobs/:id/result",
    async ({ request, params, body }) => {
      const { tenant } = await connectorAuth(request);
      if (!/^[0-9]{1,18}$/.test(params.id)) throw new HttpError(404, "not_found");
      return withTenant(tenant.id, async (tx) => {
        const [j] = await tx`select id, bill_id, order_id, attempts, status from pos_forward where id = ${params.id} for update`;
        if (!j) throw new HttpError(404, "not_found");
        if (j.status === "sent") return { ok: true, replayed: true };
        if (body.ok) {
          if (!body.posOrderId) throw new HttpError(422, "pos_order_id_required");
          // บิลหนึ่งใบผูกกับออเดอร์ POS ใบเดียว: ตั้งครั้งแรกเท่านั้น
          await tx`update bill set pos_order_id = coalesce(pos_order_id, ${body.posOrderId}) where id = ${j.bill_id}`;
          await tx`update pos_forward set status = 'sent', sent_at = now(), last_error = null, lease_until = null where id = ${j.id}`;
        } else {
          const dead = j.attempts >= MAX_ATTEMPTS || body.permanent === true;
          await tx`
            update pos_forward set status = ${dead ? "failed" : "pending"}, last_error = ${(body.error ?? "").slice(0, 300)},
              lease_until = now() + make_interval(secs => ${Math.min(600, 2 ** j.attempts * 5)}) where id = ${j.id}`;
          if (dead) await notify(tx, tenant.id, "pos.forward_failed", { id: j.order_id, billId: j.bill_id });
        }
        return { ok: true };
      });
    },
    {
      body: t.Object({
        ok: t.Boolean(),
        posOrderId: t.Optional(t.String({ maxLength: 64 })),
        error: t.Optional(t.String({ maxLength: 300 })),
        permanent: t.Optional(t.Boolean()),
      }),
    },
  )

  // บิลที่เปิดอยู่และผูกกับออเดอร์ POS แล้ว — connector ใช้ตามสถานะ/การชำระเงินใน POS
  .get("/open-bills", async ({ request }) => {
    const { tenant } = await connectorAuth(request);
    const bills = await withTenant(
      tenant.id,
      (tx) => tx`select b.id, b.pos_order_id, t.pos_table_id from bill b join dining_table t on t.id = b.table_id
                 where b.status = 'open' and b.pos_order_id is not null`,
    );
    return { bills };
  })

  // ความคืบหน้าจากครัว/POS ในร้าน → สะท้อนให้ลูกค้าเห็น
  .post(
    "/orders/:id/status",
    async ({ request, params, body }) => {
      const { tenant } = await connectorAuth(request);
      if (!UUID.test(params.id) || !(body.status in MAP_STATUS)) throw new HttpError(422, "validation");
      return withTenant(tenant.id, async (tx) => {
        const [o] = await tx`select status, bill_id from orders where id = ${params.id} for update`;
        if (!o) throw new HttpError(404, "not_found");
        if (o.status === body.status || o.status === "served" || o.status === "cancelled") return { id: params.id, status: o.status };
        await tx`update orders set status = ${body.status}, updated_at = now() where id = ${params.id}`;
        await enqueue(tx, tenant.id, "order.status", { orderId: params.id, from: o.status, to: body.status, by: "connector" });
        await notify(tx, tenant.id, "order.status", { id: params.id, billId: o.bill_id });
        return { id: params.id, status: body.status };
      });
    },
    { body: t.Object({ status: t.String({ maxLength: 20 }) }) },
  )

  // POS ในร้านรับชำระเงินแล้ว → ปิดบิล (ตัดทุก device + หมุนรหัสโต๊ะ)
  .post("/bills/:id/paid", async ({ request, params }) => {
    const { tenant, me } = await connectorAuth(request);
    if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
    return withTenant(tenant.id, async (tx) => {
      const [b] = await tx`select id from bill where id = ${params.id} and status = 'open' for update`;
      if (!b) return { id: params.id, alreadyClosed: true };
      await closeBill(tx, tenant.id, b.id, "paid", null, me.id);
      return { id: b.id, alreadyClosed: false };
    });
  });
