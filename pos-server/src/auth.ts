import { config } from "./config.ts";
import type { Tx } from "./db.ts";
import { sha256hex } from "./crypto.ts";
import { HttpError, bearer } from "./http.ts";

export interface Device {
  id: string;
  billId: string;
  tableId: string;
  joinedVia: "qr" | "invite";
}

/**
 * ยืนยัน device token ของลูกค้าจาก DB ทุกคำขอ (ต้องเรียกใน withTenant)
 * เมื่อพนักงานปิดบิล/ย้ายโต๊ะ/reset → บิลไม่ open หรือ device ถูก revoke → คำขอถัดไปถูกตัดทันที
 */
export async function deviceAuth(tx: Tx, request: Request): Promise<Device> {
  const tok = bearer(request);
  if (!tok || tok.length > 128) throw new HttpError(401, "session_invalid");
  const [d] = await tx`
    select d.id, d.bill_id, d.table_id, d.joined_via, d.revoked_at, d.epoch, b.status as bill_status, t.epoch as table_epoch
    from guest_device d join bill b on b.id = d.bill_id join dining_table t on t.id = d.table_id
    where d.token_hash = ${sha256hex(tok)}
      and d.created_at > now() - make_interval(hours => ${config.deviceMaxAgeHours})`;
  if (!d) throw new HttpError(401, "session_invalid");
  if (d.revoked_at || d.bill_status !== "open" || d.epoch !== d.table_epoch) throw new HttpError(401, "session_closed");
  return { id: d.id, billId: d.bill_id, tableId: d.table_id, joinedVia: d.joined_via };
}
