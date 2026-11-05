import { Elysia, t } from "elysia";
import { config } from "../config.ts";
import { enqueue, notify, policy, withTenant, type Tx } from "../db.ts";
import { randomToken, sha256hex, verifyTableSig } from "../crypto.ts";
import { deviceAuth } from "../auth.ts";
import { HttpError, reqCtx } from "../http.ts";
import { dbLimit } from "../ratelimit.ts";
import { MENU_TTL_MS, menuCache } from "../cache.ts";
import { ensureOpenBill } from "../sessions.ts";
import { sseResponse } from "../events.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM = /^[A-Za-z0-9_-]{16,64}$/;
const L = config.limits;
const scheme = config.prod ? "https" : "http";

/** ออก device token ใหม่ผูกกับบิล (เก็บเฉพาะ hash) */
async function issueDevice(
  tx: Tx,
  tenantId: string,
  billId: string,
  tableId: string,
  via: "qr" | "invite",
  maxDevices: number,
  clientId: string | null = null,
): Promise<string> {
  // เครื่องเดิม (clientId เดิม) สแกน/กู้คืนซ้ำ → ตัด token เก่า ออกใหม่ ไม่กินที่นั่งเพิ่ม
  const clientHash = clientId ? sha256hex(clientId) : null;
  if (clientHash) await tx`update guest_device set revoked_at = now() where bill_id = ${billId} and client_id_hash = ${clientHash} and revoked_at is null`;
  const n = (await tx`select count(*)::int as n from guest_device where bill_id = ${billId} and revoked_at is null`)[0]!.n;
  if (n >= maxDevices) throw new HttpError(429, "too_many_devices");
  const token = "d_" + randomToken(32);
  await tx`
    insert into guest_device (tenant_id, bill_id, table_id, token_hash, joined_via, epoch, client_id_hash)
    values (${tenantId}, ${billId}, ${tableId}, ${sha256hex(token)}, ${via},
            (select epoch from dining_table where id = ${tableId}), ${clientHash})`;
  return token;
}

const ORDER_SELECT = (tx: Tx) => tx`
  o.id, o.status, o.total_satang, o.note, o.created_at,
  coalesce(json_agg(json_build_object('name', i.name_snapshot, 'qty', i.qty,
           'unit_satang', i.unit_satang, 'note', i.note) order by i.id)
           filter (where i.id is not null), '[]') as items`;

export const guest = new Elysia({ prefix: "/api" })
  // สแกน QR โต๊ะ (พนักงานต้องเปิดโต๊ะก่อน) → device token
  .post(
    "/session",
    async ({ request, body }) => {
      const { ip, tenant } = await reqCtx(request);
      const pol = policy(tenant);
      if (!(await dbLimit(`sess:ip:${ip}`, L.sessionPerIp10m, 600))) throw new HttpError(429, "rate_limited");
      const [tableId, sig] = body.token.split(".");
      if (!tableId || !sig || !UUID.test(tableId)) throw new HttpError(404, "invalid_qr");

      return withTenant(tenant.id, async (tx) => {
        const [table] = await tx`select id, label, qr_version, active from dining_table where id = ${tableId}`;
        if (!table || !table.active || !verifyTableSig(tenant.id, table.id, table.qr_version, sig))
          throw new HttpError(404, "invalid_qr");

        let billId: string;
        if (pol.requireOpen) {
          const [bill] = await tx`select id from bill where table_id = ${table.id} and status = 'open'`;
          if (!bill) throw new HttpError(409, "table_not_open"); // ยังไม่มีพนักงานเปิดโต๊ะ
          billId = bill.id;
        } else {
          billId = await ensureOpenBill(tx, tenant.id, table.id);
        }
        const via = "qr" as const;
        const device = await issueDevice(tx, tenant.id, billId, table.id, via, pol.maxDevicesPerBill, body.clientId ?? null);
        return {
          device,
          table: { label: table.label },
          tenant: { name: tenant.name },
          joinedVia: via,
          canInvite: true,
          requireConfirm: pol.requireConfirm,
          orderToken: pol.orderToken,
        };
      });
    },
    {
      body: t.Object({
        token: t.String({ minLength: 10, maxLength: 200 }),
        clientId: t.Optional(t.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" })),
      }),
    },
  )

  // ข้อมูล session ปัจจุบัน (ใช้ตอนรีโหลดหน้า)
  .get("/session", async ({ request }) => {
    const { tenant } = await reqCtx(request);
    return withTenant(tenant.id, async (tx) => {
      const dev = await deviceAuth(tx, request);
      const [row] = await tx`select label from dining_table where id = ${dev.tableId}`;
      return {
        table: { label: row?.label },
        tenant: { name: tenant.name },
        joinedVia: dev.joinedVia,
        canInvite: dev.joinedVia !== "invite",
        requireConfirm: policy(tenant).requireConfirm,
        orderToken: policy(tenant).orderToken,
      };
    });
  })

  // ขอ order token ใช้ครั้งเดียว (อายุ 10 นาที ผูกกับเครื่อง) — ใช้เมื่อร้านเปิด order_token
  .post("/orders/token", async ({ request }) => {
    const { tenant } = await reqCtx(request);
    return withTenant(tenant.id, async (tx) => {
      const dev = await deviceAuth(tx, request);
      if (!(await dbLimit(`otok:${dev.id}`, L.orderTokenPerDevice10m, 600))) throw new HttpError(429, "rate_limited");
      const tok = "o_" + randomToken(24);
      const [r] = await tx`
        insert into order_token (tenant_id, device_id, token_hash, expires_at)
        values (${tenant.id}, ${dev.id}, ${sha256hex(tok)}, now() + make_interval(secs => ${L.orderTokenTtlSec}))
        returning expires_at`;
      return { orderToken: tok, expiresAt: r!.expires_at };
    });
  })

  // Phase 4: ลูกค้าที่เข้าด้วย QR โต๊ะ สร้าง QR ชั่วคราว (5 นาที) ชวนเพื่อนร่วมโต๊ะ
  .post("/session/invite", async ({ request }) => {
    const { tenant } = await reqCtx(request);
    return withTenant(tenant.id, async (tx) => {
      const dev = await deviceAuth(tx, request);
      if (dev.joinedVia === "invite") throw new HttpError(403, "forbidden"); // ชวนต่อเป็นทอด ๆ ไม่ได้
      if (!(await dbLimit(`invite:${dev.billId}`, L.invitePerBill1h, 3600))) throw new HttpError(429, "rate_limited");
      const code = randomToken(16);
      const [inv] = await tx`
        insert into guest_session_invites (tenant_id, bill_id, created_by_device, code_hash, expires_at, max_uses)
        values (${tenant.id}, ${dev.billId}, ${dev.id}, ${sha256hex(code)},
                now() + make_interval(secs => ${L.inviteTtlSec}), ${L.inviteMaxUses})
        returning expires_at`;
      return {
        code,
        url: `${scheme}://${tenant.slug}.${config.baseDomain}/j/${code}`,
        expiresAt: inv!.expires_at,
      };
    });
  })

  // Phase 4: เพื่อนสแกน QR ชั่วคราว → เข้ากลุ่มทันทีโดยไม่ต้องสแกน QR โต๊ะ และได้ device token ใหม่
  .post(
    "/session/join",
    async ({ request, body }) => {
      const { ip, tenant } = await reqCtx(request);
      if (!(await dbLimit(`join:ip:${ip}`, L.joinPerIp10m, 600))) throw new HttpError(429, "rate_limited");
      const pol = policy(tenant);
      return withTenant(tenant.id, async (tx) => {
        const [inv] = await tx`
          select i.id, i.bill_id, i.uses, i.max_uses, b.table_id, t.label
          from guest_session_invites i
          join bill b on b.id = i.bill_id and b.status = 'open'
          join dining_table t on t.id = b.table_id
          where i.code_hash = ${sha256hex(body.code)} and i.expires_at > now()
          for update of i`;
        if (!inv || inv.uses >= inv.max_uses) throw new HttpError(404, "invite_invalid");
        const device = await issueDevice(tx, tenant.id, inv.bill_id, inv.table_id, "invite", pol.maxDevicesPerBill);
        await tx`update guest_session_invites set uses = uses + 1 where id = ${inv.id}`;
        return {
          device,
          table: { label: inv.label },
          tenant: { name: tenant.name },
          joinedVia: "invite" as const,
          canInvite: false,
          requireConfirm: pol.requireConfirm,
          orderToken: pol.orderToken,
        };
      });
    },
    { body: t.Object({ code: t.String({ minLength: 16, maxLength: 64 }) }) },
  )

  .get("/menu", async ({ request, set }) => {
    const { tenant } = await reqCtx(request);
    set.headers["cache-control"] = "public, max-age=15";
    const hit = menuCache.get(tenant.id);
    if (hit && hit.exp > Date.now()) return hit.body;
    const items = await withTenant(
      tenant.id,
      (tx) => tx`
        select id, name, description, category, price_satang, image_url
        from menu_item where available order by sort, name`,
    );
    const body = { items };
    menuCache.set(tenant.id, { exp: Date.now() + MENU_TTL_MS, body });
    return body;
  })

  .post(
    "/orders",
    async ({ request, body, set }) => {
      const { ip, tenant } = await reqCtx(request);
      const idem = request.headers.get("idempotency-key") ?? "";
      if (!IDEM.test(idem)) throw new HttpError(400, "idempotency_key_required");
      if (!(await dbLimit(`ord:ip:${ip}`, L.orderPerIp10m, 600))) throw new HttpError(429, "rate_limited");

      if (body.items.length > L.maxLines) throw new HttpError(422, "too_many_lines");
      const totalQty = body.items.reduce((a, i) => a + i.qty, 0);
      if (totalQty > L.maxTotalQty) throw new HttpError(422, "too_many_items");
      const pol = policy(tenant);
      const hash = sha256hex(JSON.stringify([body.items.map((i) => [i.menuItemId, i.qty, i.note ?? ""]), body.note ?? ""]));

      const result = await withTenant(tenant.id, async (tx) => {
        const dev = await deviceAuth(tx, request);

        // retry ด้วย key เดิม → ได้ออเดอร์เดิม (ข้าม cooldown/โควตา เพราะไม่ใช่ออเดอร์ใหม่)
        const replay = async () => {
          const [ex] = await tx`
            select id, status, total_satang, created_at, request_hash, bill_id from orders where idempotency_key = ${idem}`;
          if (!ex) return null;
          if (ex.request_hash !== hash || ex.bill_id !== dev.billId) throw new HttpError(422, "idempotency_mismatch");
          return { order: { id: ex.id, status: ex.status, total_satang: ex.total_satang, created_at: ex.created_at }, replayed: true };
        };
        const prior = await replay();
        if (prior) return prior;

        // order token ใช้ครั้งเดียว: ตรวจ+ใช้แบบ atomic ใน UPDATE เดียว (ถ้าขั้นต่อไปล้ม ทรานแซกชัน rollback → token ยังใช้ได้)
        if (pol.orderToken) {
          const ot = request.headers.get("x-order-token") ?? "";
          const [used] = ot.length >= 16 && ot.length <= 80
            ? await tx`update order_token set used_at = now()
                       where token_hash = ${sha256hex(ot)} and device_id = ${dev.id} and used_at is null and expires_at > now()
                       returning id`
            : [];
          if (!used) throw new HttpError(403, "order_token_invalid");
        }

        // lock บิลก่อน แล้ว lock device (ลำดับเดียวกันเสมอ กัน deadlock; ปิดบิลก็ lock บิลก่อนเช่นกัน)
        const [bill] = await tx`select status from bill where id = ${dev.billId} for update`;
        if (!bill || bill.status !== "open") throw new HttpError(401, "session_closed");

        // Phase 5: cooldown ต่อ device
        const [d] = await tx`
          select extract(epoch from (now() - last_order_at)) as since from guest_device where id = ${dev.id} for update`;
        if (pol.cooldownSec > 0 && d && d.since !== null && Number(d.since) < pol.cooldownSec)
          throw new HttpError(429, "order_cooldown", { retryAfterSec: Math.min(pol.cooldownSec, Math.max(1, Math.ceil(pol.cooldownSec - Number(d.since)))) });

        // Phase 5: โควตาออเดอร์ต่อบิล (นับรวมที่ยกเลิกด้วย กันสแปมแล้วยกเลิกวน)
        const used = (await tx`select count(*)::int as n from orders where bill_id = ${dev.billId}`)[0]!.n;
        if (used >= pol.maxOrdersPerBill) throw new HttpError(403, "order_quota_exceeded", { limit: pol.maxOrdersPerBill });

        // ราคามาจาก DB เท่านั้น
        const ids = [...new Set(body.items.map((i) => i.menuItemId))];
        const menu = await tx`select id, name, price_satang, available from menu_item where id in ${tx(ids)}`;
        const byId = new Map(menu.map((m) => [m.id as string, m]));
        const bad = ids.filter((id) => !byId.get(id)?.available);
        if (bad.length) throw new HttpError(409, "item_unavailable", { items: bad });

        let total = 0;
        const lines = body.items.map((i) => {
          const m = byId.get(i.menuItemId)!;
          total += m.price_satang * i.qty;
          return { tenant_id: tenant.id, menu_item_id: m.id, name_snapshot: m.name, unit_satang: m.price_satang, qty: i.qty, note: i.note ?? null };
        });
        if (total > 100_000_000) throw new HttpError(422, "total_too_large");

        let needConfirm = pol.requireConfirm;
        if (needConfirm && pol.confirmFirstOnly) {
          // บิลนี้พนักงานเคยรับออเดอร์แล้ว = ไว้ใจ session นี้ (ตรวจใต้ lock ของบิลแล้ว)
          const [trusted] = await tx`
            select 1 as x from orders where bill_id = ${dev.billId} and status not in ('pending_confirm', 'cancelled') limit 1`;
          if (trusted) needConfirm = false;
        }
        const status = needConfirm ? "pending_confirm" : "accepted";
        const [row] = await tx`
          insert into orders (tenant_id, bill_id, status, idempotency_key, request_hash, total_satang, note, device_id)
          values (${tenant.id}, ${dev.billId}, ${status}, ${idem}, ${hash}, ${total}, ${body.note ?? null}, ${dev.id})
          on conflict (tenant_id, idempotency_key) do nothing
          returning id, status, total_satang, created_at`;
        if (!row) {
          const again = await replay();
          if (again) return again;
          throw new HttpError(409, "conflict");
        }
        const withOrder = lines.map((l) => ({ ...l, order_id: row.id }));
        await tx`insert into order_item ${tx(withOrder as never, "tenant_id", "order_id", "menu_item_id", "name_snapshot", "unit_satang", "qty", "note")}`;
        await tx`update guest_device set last_order_at = now() where id = ${dev.id}`;
        await enqueue(tx, tenant.id, "order.created", { orderId: row.id });
        if (pol.posForward) await tx`insert into pos_forward (tenant_id, order_id, bill_id) values (${tenant.id}, ${row.id}, ${dev.billId})`;
        await notify(tx, tenant.id, "order.created", { id: row.id, billId: dev.billId });
        return { order: { id: row.id, status: row.status, total_satang: row.total_satang, created_at: row.created_at }, replayed: false };
      });

      set.status = result.replayed ? 200 : 201;
      return result;
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            menuItemId: t.String({
              pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            }),
            qty: t.Integer({ minimum: 1, maximum: L.maxQtyPerLine }),
            note: t.Optional(t.String({ maxLength: 200 })),
          }),
          { minItems: 1, maxItems: L.maxLines },
        ),
        note: t.Optional(t.String({ maxLength: 200 })),
      }),
    },
  )

  // ออเดอร์ทั้งหมดของบิล (ทุกคนในโต๊ะเห็นร่วมกัน)
  .get("/orders", async ({ request }) => {
    const { tenant } = await reqCtx(request);
    const orders = await withTenant(tenant.id, async (tx) => {
      const dev = await deviceAuth(tx, request);
      return tx`
        select ${ORDER_SELECT(tx)}
        from orders o left join order_item i on i.order_id = o.id
        where o.bill_id = ${dev.billId}
        group by o.id order by o.created_at`;
    });
    return { orders };
  })

  .get("/orders/:id", async ({ request, params }) => {
    const { tenant } = await reqCtx(request);
    if (!UUID.test(params.id)) throw new HttpError(404, "not_found");
    const [order] = await withTenant(tenant.id, async (tx) => {
      const dev = await deviceAuth(tx, request);
      return tx`
        select ${ORDER_SELECT(tx)}
        from orders o left join order_item i on i.order_id = o.id
        where o.id = ${params.id} and o.bill_id = ${dev.billId}
        group by o.id`;
    });
    if (!order) throw new HttpError(404, "not_found");
    return { order };
  })

  // SSE ฝั่งลูกค้า: รับสถานะออเดอร์ของบิลตัวเอง และถูกตัดทันทีเมื่อพนักงานปิดบิล (ใช้ fetch stream + header)
  .get("/events", async ({ request }) => {
    const { tenant } = await reqCtx(request);
    const dev = await withTenant(tenant.id, (tx) => deviceAuth(tx, request));
    return sseResponse(tenant.id, request, { billId: dev.billId });
  });
