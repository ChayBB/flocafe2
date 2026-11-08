import { generateKeyPairSync, sign } from "node:crypto";
import WebSocket from "ws";
import { describe, expect, test } from "bun:test";
import { createRelayApp } from "./app";
import { MemoryRelayRepository, type QueuedOrder, type QueuedOrderResult } from "./repository";

describe("POS tunnel forwarding", () => {
  test("authenticates the paired POS and forwards only guest traffic", async () => {
    const repository = new MemoryRelayRepository();
    let queued: QueuedOrder | null = null;
    let queuedHash: string | undefined;
    let result: QueuedOrderResult | null = null;
    let readyToDeliver = false;
    const app = createRelayApp({
      repository,
      outbox: {
        async findOrder(storeId, key, hash) {
          return queued?.storeId === storeId && queued.key === key
            ? { conflict: hash !== queuedHash, result }
            : null;
        },
        async enqueueOrder(storeId, key, hash, payload) {
          if (!queued) {
            queued = { storeId, key, payload, attempts: 0 };
            queuedHash = hash;
            readyToDeliver = true;
          }
          return { conflict: hash !== queuedHash, result };
        },
        async claimOrder() {
          if (!queued || !readyToDeliver) return null;
          readyToDeliver = false;
          return { ...queued, attempts: ++queued.attempts };
        },
        async settleOrder(_order, settled) {
          result = settled;
          readyToDeliver = !settled;
        },
        async listOrdersForReview() { return []; },
      },
      adminToken: "test-admin-token",
      publicBaseUrl: "https://qr.example.test",
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const start = await (await app.handle(new Request("http://local/api/pos/pair/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: publicKeyBase64, device_name: "test-pos" }),
    }))).json();
    await app.handle(new Request("http://local/api/pos/pair/approve", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ code: start.code, store_id: "cafe-one" }),
    }));

    app.listen(0);
    const port = app.server?.port;
    console.log("test ws server port", port);
    expect(port).toBeNumber();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/pos/tunnel`, {
      headers: { "X-Flo-Store": "cafe-one" },
    });
    const messageQueue: Record<string, unknown>[] = [];
    const waiters = new Map<string, (message: Record<string, unknown>) => void>();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      console.log("test ws message", message);
      const key = String(message.type);
      const waiter = waiters.get(key);
      if (waiter) {
        waiters.delete(key);
        waiter(message);
      } else {
        messageQueue.push(message);
      }
    });
    const waitForType = (type: string) => {
      const index = messageQueue.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messageQueue.splice(index, 1)[0]);
      return new Promise<Record<string, unknown>>((resolve) => waiters.set(type, resolve));
    };

    try {
      const challengePromise = waitForType("challenge");
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const challenge = await challengePromise;
      socket.send(JSON.stringify({
        type: "auth",
        store_id: "cafe-one",
        signature: sign(null, Buffer.from(`tunnel:${challenge.nonce}`), privateKey).toString("base64url"),
      }));
      await waitForType("ready");

      const spoofed = await app.handle(
        new Request("https://qr.example.test/api/guest/menu", { headers: { "x-forwarded-for": "198.51.100.9" } }),
      );
      expect(spoofed.status).toBe(400);

      const menuRequest = app.handle(
        new Request("https://qr.example.test/api/guest/menu?lang=th", {
          headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" },
        }),
      );
      const forwarded = await waitForType("request");
      expect(forwarded).toMatchObject({
        type: "request",
        method: "GET",
        path: "/api/guest/menu?lang=th",
        client_ip: "203.0.113.7",
      });
      socket.send(JSON.stringify({
        type: "response",
        id: forwarded.id,
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "must-not-pass" },
        body: Buffer.from(JSON.stringify({ categories: [], products: [] })).toString("base64"),
      }));
      const response = await menuRequest;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ categories: [], products: [] });
      expect(response.headers.has("set-cookie")).toBe(false);

      // A content-hashed chunk crosses the tunnel once; later guests get the relay's copy.
      const chunkUrl = "https://qr.example.test/_next/static/chunks/app-abc123.js";
      const guest = { headers: { "cf-connecting-ip": "203.0.113.7" } };
      const firstChunk = app.handle(new Request(chunkUrl, guest));
      const chunkForward = await waitForType("request");
      socket.send(JSON.stringify({
        type: "response",
        id: chunkForward.id,
        status: 200,
        headers: { "content-type": "application/javascript", "cache-control": "public, max-age=0" },
        body: Buffer.from("console.log(1)").toString("base64"),
      }));
      const chunk = await firstChunk;
      expect(chunk.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await chunk.text()).toBe("console.log(1)");
      const cachedChunk = await app.handle(new Request(chunkUrl, guest));
      expect(await cachedChunk.text()).toBe("console.log(1)");
      expect(messageQueue.filter((message) => message.type === "request")).toHaveLength(0);

      const blocked = await app.handle(new Request("https://qr.example.test/api/orders"));
      expect(blocked.status).toBe(404);

      const submitOrder = (quantity = 1, lookup = false) => app.handle(new Request(
        "https://qr.example.test/api/guest/order" + (lookup ? "/status" : ""), {
        method: "POST",
        headers: { ...guest.headers, "content-type": "application/json" },
        body: JSON.stringify({
          table_id: "table-one", device_token: "device-token", idempotency_key: "guest-key-1",
          items: [{ product_id: "coffee", quantity }],
        }),
      }));
      expect((await submitOrder(1, true)).status).toBe(404);
      expect(queued).toBeNull();
      expect((await submitOrder()).status).toBe(202);
      const firstAttempt = await waitForType("request");
      expect(firstAttempt).toMatchObject({ method: "POST", path: "/api/guest/order" });
      expect((await submitOrder(2)).status).toBe(409);
      expect((await submitOrder(2, true)).status).toBe(404);
      // The first request reached the POS, but its response never reaches the relay.
      expect((await submitOrder(1, true)).status).toBe(202);
      const retry = await waitForType("request");
      expect(retry.id).not.toBe(firstAttempt.id);
      expect(retry.body).toBe(firstAttempt.body);
      socket.send(JSON.stringify({
        type: "response", id: retry.id, status: 201,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          success: true, idempotency_key: "guest-key-1", order_number: "ORD-1",
        })).toString("base64"),
      }));
      let delivered = await submitOrder(1, true);
      for (let poll = 0; delivered.status === 202 && poll < 20; poll++) {
        await Bun.sleep(50);
        delivered = await submitOrder(1, true);
      }
      expect(delivered.status).toBe(201);
      expect(await delivered.json()).toEqual({ success: true, order_number: "ORD-1" });
    } finally {
      socket.close();
      await app.stop(true);
    }
  }, 25_000);
});
