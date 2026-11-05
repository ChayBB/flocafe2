import type { Tx } from "./db.ts";
import { enqueue, notify } from "./db.ts";
import { HttpError } from "./http.ts";

export type RotateAction = CloseReason | "manual_rotate";
export type CloseReason = "paid" | "cancelled" | "moved" | "daily_reset";

/** เปิดโต๊ะ (พนักงานกด) = สร้างบิล/session — คืน null ถ้าโต๊ะนี้มีบิลเปิดอยู่แล้ว (unique index one_open_bill) */
export async function openBill(
  tx: Tx,
  tenantId: string,
  tableId: string,
  openedBy: string | null,
): Promise<{ id: string } | null> {
  const [b] = await tx`
    insert into bill (tenant_id, table_id, opened_by) values (${tenantId}, ${tableId}, ${openedBy})
    on conflict (table_id) where status = 'open' do nothing
    returning id`;
  if (!b) return null;
  await notify(tx, tenantId, "bill.opened", { id: b.id, billId: b.id });
  return { id: b.id };
}

/** ร้านที่ปิด require_open: บิลเปิดอัตโนมัติเมื่อมีคนสแกน QR — ปลอดภัยเมื่อสแกนพร้อมกัน */
export async function ensureOpenBill(tx: Tx, tenantId: string, tableId: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const [cur] = await tx`select id from bill where table_id = ${tableId} and status = 'open' for share`;
    if (cur) return cur.id;
    const [ins] = await tx`
      insert into bill (tenant_id, table_id) values (${tenantId}, ${tableId})
      on conflict (table_id) where status = 'open' do nothing
      returning id`;
    if (ins) return ins.id;
  }
  throw new HttpError(409, "bill_busy");
}

/**
 * ปิดบิล (session) และตัดทุก device ทันที: revoke token ทั้งหมด + ทำให้ QR ชวนเพื่อนหมดอายุ
 * ต้องเรียกโดยถือ lock ของแถวบิล (select … for update) แล้ว
 */
export async function closeBill(
  tx: Tx,
  tenantId: string,
  billId: string,
  reason: CloseReason,
  movedToBillId: string | null = null,
  actor: string | null = null,
): Promise<void> {
  const [b] = await tx`
    update bill set status = 'closed', closed_at = now(), closed_reason = ${reason}, moved_to_bill_id = ${movedToBillId}
    where id = ${billId} and status = 'open'
    returning table_id`;
  await tx`update guest_device set revoked_at = now() where bill_id = ${billId} and revoked_at is null`;
  await tx`update guest_session_invites set expires_at = least(expires_at, now()) where bill_id = ${billId}`;
  if (b) await rotateTable(tx, tenantId, b.table_id, reason, { billId, actor });
  await enqueue(tx, tenantId, "bill.closed", { billId, reason, movedToBillId });
  await notify(tx, tenantId, "bill.closed", { id: billId, billId, reason });
}

/** ยกเลิกออเดอร์ที่ยังไม่เสิร์ฟของบิล (ที่เสิร์ฟแล้วไม่แตะ) */
export async function cancelUnservedOrders(tx: Tx, tenantId: string, billId: string | null): Promise<string[]> {
  const rows = billId
    ? await tx`update orders set status = 'cancelled', updated_at = now()
               where bill_id = ${billId} and status in ${tx(["pending_confirm", "accepted", "preparing", "ready"])}
               returning id, bill_id`
    : await tx`update orders set status = 'cancelled', updated_at = now()
               where status in ${tx(["pending_confirm", "accepted", "preparing", "ready"])}
               returning id, bill_id`;
  for (const r of rows) await notify(tx, tenantId, "order.status", { id: r.id, billId: r.bill_id });
  return rows.map((r) => r.id as string);
}

/**
 * หมุนรหัสโต๊ะ: epoch + 1 (device ที่ออกใน epoch เก่าใช้ไม่ได้อีก) + audit + แจ้งระบบอื่น (outbox table.rotated)
 * เรียกในทรานแซกชันเดียวกับการปิดบิล → หมุนพร้อมกันหรือไม่หมุนเลย
 */
export async function rotateTable(
  tx: Tx,
  tenantId: string,
  tableId: string,
  action: RotateAction,
  o: { billId?: string | null; actor?: string | null; reason?: string | null } = {},
): Promise<number> {
  const [t] = await tx`update dining_table set epoch = epoch + 1 where id = ${tableId} returning epoch`;
  if (!t) throw new HttpError(404, "not_found");
  await tx`
    insert into table_audit (tenant_id, table_id, bill_id, epoch, action, reason, actor)
    values (${tenantId}, ${tableId}, ${o.billId ?? null}, ${t.epoch}, ${action}, ${o.reason ?? null}, ${o.actor ?? null})`;
  await enqueue(tx, tenantId, "table.rotated", { tableId, epoch: t.epoch, action });
  return t.epoch as number;
}

/** พนักงานสั่งหมุนเอง: ตัดทุก device + invite ของบิลที่เปิดอยู่ แต่ไม่ปิดบิล (ลูกค้าที่นั่งอยู่จริงสแกน QR เข้าใหม่) */
export async function rotateOpenBill(tx: Tx, tenantId: string, billId: string, tableId: string, actor: string, reason: string | null) {
  await tx`update guest_device set revoked_at = now() where bill_id = ${billId} and revoked_at is null`;
  await tx`update guest_session_invites set expires_at = least(expires_at, now()) where bill_id = ${billId}`;
  const epoch = await rotateTable(tx, tenantId, tableId, "manual_rotate", { billId, actor, reason });
  await notify(tx, tenantId, "bill.closed", { id: billId, billId, reason: "rotated" }); // ตัด SSE ของลูกค้าทันที
  return epoch;
}
