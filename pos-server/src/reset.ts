import { config } from "./config.ts";
import { enqueue, notify, sql, withTenant, type Tx } from "./db.ts";
import { cancelUnservedOrders, closeBill } from "./sessions.ts";

/**
 * Daily Reset ของหนึ่งร้าน: ปิดทุกบิลที่เปิดอยู่ (ตัดทุก device), ยกเลิกออเดอร์ที่ยังไม่เสิร์ฟค้างจากเมื่อวาน
 * ออเดอร์ที่เสิร์ฟแล้วคงสถานะเดิมไว้เป็นประวัติ
 */
export async function resetTenant(tx: Tx, tenantId: string): Promise<{ closedBills: number; cancelledOrders: number }> {
  const bills = await tx`select id from bill where status = 'open' for update`;
  const cancelled = await cancelUnservedOrders(tx, tenantId, null);
  for (const b of bills) await closeBill(tx, tenantId, b.id, "daily_reset");
  await enqueue(tx, tenantId, "tenant.reset", { closedBills: bills.length, cancelledOrders: cancelled.length });
  await notify(tx, tenantId, "tenant.reset");
  return { closedBills: bills.length, cancelledOrders: cancelled.length };
}

export interface ResetReport {
  tenantId: string;
  action: "reset" | "skipped_late";
  closedBills?: number;
  cancelledOrders?: number;
}

/**
 * เรียกจาก worker ทุก ~30 วินาที: หาร้านที่ถึงเวลา reset ของวัน (ตาม tz ของร้าน) แต่ยังไม่ได้ทำ
 * - จองรอบด้วย UPDATE last_reset_on แบบ atomic → รันหลาย worker ก็ไม่ reset ซ้ำ
 * - ถ้าล่าช้าเกิน graceMinutes (เช่น worker ดับ) ข้ามรอบ เพื่อไม่ตัด session ที่กำลังกินข้าวอยู่กลางวัน
 */
export async function runDueResets(opts: { tenantIds?: string[] } = {}): Promise<ResetReport[]> {
  const due = await sql<{ id: string }[]>`
    select id from tenant
    where active and reset_enabled
      and (last_reset_on is null or last_reset_on < (now() at time zone tz)::date)
      and (now() at time zone tz)::time >= reset_time
      ${opts.tenantIds ? sql`and id in ${sql(opts.tenantIds)}` : sql``}`;
  const out: ResetReport[] = [];
  for (const { id } of due) {
    const [claimed] = await sql<{ late_min: number }[]>`
      update tenant set last_reset_on = (now() at time zone tz)::date
      where id = ${id} and (last_reset_on is null or last_reset_on < (now() at time zone tz)::date)
      returning extract(epoch from ((now() at time zone tz)::time - reset_time)) / 60 as late_min`;
    if (!claimed) continue; // worker อื่นจองไปแล้ว
    if (Number(claimed.late_min) > config.reset.graceMinutes) {
      out.push({ tenantId: id, action: "skipped_late" });
      continue;
    }
    const r = await withTenant(id, (tx) => resetTenant(tx, id));
    out.push({ tenantId: id, action: "reset", ...r });
  }
  return out;
}
