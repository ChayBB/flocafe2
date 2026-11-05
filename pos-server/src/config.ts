function secret(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 32) throw new Error(`${name} must be set (>= 32 chars)`);
  return v;
}

const prod = process.env.NODE_ENV === "production";

export const config = {
  prod,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  baseDomain: (process.env.BASE_DOMAIN ?? "localhost").toLowerCase(),
  // secret อยู่ใน env เท่านั้น ไม่เก็บใน DB (device token เป็นค่าสุ่มเก็บ hash จึงไม่ต้องมี secret สำหรับ session)
  guestQrSecret: secret("GUEST_QR_SECRET"),
  deviceMaxAgeHours: 12, // device token อายุสูงสุด (daily reset/ปิดบิลตัดก่อนหน้านี้อยู่แล้ว)
  limits: {
    maxBodyBytes: 128 * 1024,
    maxLines: 30,
    maxQtyPerLine: 20,
    maxTotalQty: 60, // จำกัดจำนวนชิ้นรวมต่อออเดอร์
    // rate limit ต่อ IP แบบหลวม (wifi ร้านร่วมกันได้) ตัวหลักคือ cooldown ต่อ device + โควตาต่อบิล
    ipPerMin: 300,
    sessionPerIp10m: 60,
    orderPerIp10m: 60,
    joinPerIp10m: 60,
    staffFailPerIp10m: 20,
    invitePerBill1h: 10,
    orderTokenTtlSec: 600,
    orderTokenPerDevice10m: 30,
    inviteTtlSec: 300, // QR ชวนเพื่อนอายุ 5 นาที
    inviteMaxUses: 8,
    sseStaffMax: 20,
    sseGuestMaxPerTenant: 500,
  },
  reset: { graceMinutes: 30 }, // พลาดเวลา reset เกินนี้ → ข้ามรอบ ไม่ reset กลางมื้อ
};
