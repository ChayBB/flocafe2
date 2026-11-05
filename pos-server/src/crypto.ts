import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

export const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const safeEqStr = (a: string, b: string) => safeEq(Buffer.from(a), Buffer.from(b));

// ---------- QR โต๊ะ: `${tableId}.${sig}` (พิมพ์ถาวรบนโต๊ะ — ไม่ใช่ตัวพิสูจน์ว่านั่งอยู่จริง การเข้าได้ต้องให้พนักงานเปิดโต๊ะก่อน) ----------
export function tableToken(tenantId: string, tableId: string, qrVersion: number): string {
  const sig = hmac(config.guestQrSecret, `qr:${tenantId}:${tableId}:${qrVersion}`);
  return `${tableId}.${b64u(sig)}`;
}

export function verifyTableSig(tenantId: string, tableId: string, qrVersion: number, sigB64: string): boolean {
  const expected = hmac(config.guestQrSecret, `qr:${tenantId}:${tableId}:${qrVersion}`);
  return safeEq(expected, Buffer.from(sigB64, "base64url"));
}
