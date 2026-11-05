import { createPublicKey, verify } from "node:crypto";

export function verifyEd25519(publicKeyBase64: string, payload: string, signatureBase64Url: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(payload), key, Buffer.from(signatureBase64Url, "base64url"));
  } catch {
    return false;
  }
}
