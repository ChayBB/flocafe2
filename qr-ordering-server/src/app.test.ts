import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createRelayApp } from "./app";
import { MemoryRelayRepository } from "./repository";

const postJson = (url: string, body: unknown, headers: HeadersInit = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const signed = (privateKey: KeyObject, action: string, subject: string, ts = Date.now()) => {
  const nonce = randomBytes(16).toString("base64url");
  const signature = sign(null, Buffer.from(`${action}:${subject}:${ts}:${nonce}`), privateKey).toString("base64url");
  return { ts, nonce, signature };
};

describe("FloCafe POS pairing API", () => {
  test("issues a six-digit code, requires admin approval, and verifies signed status", async () => {
    const repo = new MemoryRelayRepository();
    const app = createRelayApp({
      repository: repo,
      adminToken: "test-admin-token",
      publicBaseUrl: "https://qr.example.test",
      logger: false,
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

    const startResponse = await app.handle(
      postJson("/api/pos/pair/start", { public_key: publicKeyBase64, device_name: "test-pos" }),
    );
    expect(startResponse.status).toBe(200);
    const start = await startResponse.json();
    expect(start.code).toMatch(/^\d{6}$/);
    expect(start.pairing_id).toBeString();
    expect(start.expires_at).toBeString();

    const pendingResponse = await app.handle(
      postJson("/api/pos/pair/status", {
        pairing_id: start.pairing_id,
        ...signed(privateKey, "pair", start.pairing_id),
      }),
    );
    expect(await pendingResponse.json()).toEqual({ status: "pending" });

    const approveResponse = await app.handle(
      postJson(
        "/api/pos/pair/approve",
        { code: start.code, store_id: "cafe-one" },
        { authorization: "Bearer test-admin-token" },
      ),
    );
    expect(approveResponse.status).toBe(200);

    const statusResponse = await app.handle(
      postJson("/api/pos/pair/status", {
        pairing_id: start.pairing_id,
        ...signed(privateKey, "pair", start.pairing_id),
      }),
    );
    expect(await statusResponse.json()).toMatchObject({
      status: "approved",
      store_id: "cafe-one",
      public_base_url: "https://qr.example.test",
    });

    // A captured call cannot be sent again, nor one signed long ago.
    const once = { pairing_id: start.pairing_id, ...signed(privateKey, "pair", start.pairing_id) };
    expect((await app.handle(postJson("/api/pos/pair/status", once))).status).toBe(200);
    expect((await app.handle(postJson("/api/pos/pair/status", once))).status).toBe(403);
    const stale = signed(privateKey, "pair", start.pairing_id, Date.now() - 10 * 60_000);
    expect(
      (await app.handle(postJson("/api/pos/pair/status", { pairing_id: start.pairing_id, ...stale }))).status,
    ).toBe(403);

    const unpair = { store_id: "cafe-one", ...signed(privateKey, "unpair", "cafe-one") };
    expect((await app.handle(postJson("/api/pos/unpair", { ...unpair, nonce: "x".repeat(22) }))).status).toBe(403);
    expect((await app.handle(postJson("/api/pos/unpair", unpair))).status).toBe(200);
    expect((await app.handle(postJson("/api/pos/unpair", unpair))).status).toBe(403);
  });

  test("rejects a bad key and protects admin approval with a token", async () => {
    const app = createRelayApp({
      repository: new MemoryRelayRepository(),
      adminToken: "test-admin-token",
      publicBaseUrl: "https://qr.example.test",
      logger: false,
    });
    const badKey = await app.handle(
      postJson("/api/pos/pair/start", { public_key: "not-a-key", device_name: "bad" }),
    );
    expect(badKey.status).toBe(400);

    const unauthorized = await app.handle(
      postJson("/api/pos/pair/approve", { code: "123456" }),
    );
    expect(unauthorized.status).toBe(401);
  });

  test("takes the customer address from the edge header, never from X-Forwarded-For", async () => {
    const app = createRelayApp({
      repository: new MemoryRelayRepository(),
      adminToken: "test-admin-token",
      publicBaseUrl: "https://qr.example.test",
      logger: false,
    });
    const menu = (headers: Record<string, string>) =>
      app.handle(new Request("https://unknown.example.test/api/guest/menu", { headers }));
    const spoofed = await menu({ "x-forwarded-for": "198.51.100.9" });
    expect(spoofed.status).toBe(400);
    expect((await spoofed.json()).code).toBe("client_ip_missing");
    expect((await menu({ "cf-connecting-ip": "not-an-ip" })).status).toBe(400);
    // With a real address the request goes on to the store lookup.
    expect((await menu({ "cf-connecting-ip": "203.0.113.7" })).status).toBe(404);
  });
});
