import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { verifyEd25519 } from "./crypto";

describe("Ed25519 relay authentication", () => {
  test("accepts a signature from the paired POS key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const payload = "pair:pairing-123";
    const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
    expect(verifyEd25519(publicKeyDer, payload, signature)).toBe(true);
  });

  test("rejects altered payloads and malformed key material", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const signature = sign(null, Buffer.from("pair:pairing-123"), privateKey).toString("base64url");
    expect(verifyEd25519(publicKeyDer, "pair:another", signature)).toBe(false);
    expect(verifyEd25519("not-a-key", "pair:pairing-123", signature)).toBe(false);
    expect(verifyEd25519(publicKeyDer, "pair:pairing-123", "bad-signature")).toBe(false);
  });
});
