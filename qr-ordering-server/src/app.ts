import { createHash, createPublicKey, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Elysia } from "elysia";
import { isRelayPathAllowed } from "./relay-policy";
import { verifyEd25519 } from "./crypto";
import type { OrderOutbox, QueuedOrderRequest, QueuedOrderResult, RelayRepository } from "./repository";

const PAIRING_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_IN_FLIGHT_PER_STORE = 20;
// The seventh attempt runs after at least 315 seconds of backoff.
const MAX_ORDER_ATTEMPTS = 7;
const ORDER_WORKER_INTERVAL_MS = 1000;
/** A signed pairing or unpair call is accepted this long after it was signed, and only once. */
const SIGNED_CALL_WINDOW_MS = 5 * 60_000;
/** Content-hashed page chunks are kept here, so a guest's page load mostly skips the POS tunnel. */
const STATIC_CACHE_BYTES = 64 * 1024 * 1024;
const STATIC_ENTRY_MAX_BYTES = 4 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const FORWARDED_HEADERS = ["accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "user-agent"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "content-language"];

type RelayOptions = {
  repository: RelayRepository;
  outbox?: OrderOutbox;
  adminToken: string;
  publicBaseUrl: string;
  logger?: boolean;
  /** Header the edge sets to the customer's address (Cloudflare: cf-connecting-ip); empty uses the socket address. */
  clientIpHeader?: string;
};

type RequestIpServer = { requestIP: (request: Request) => { address: string } | null } | null | undefined;

type RelaySocket = {
  data: { request: Request };
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type SocketState = { storeId: string; nonce: string; authenticated: boolean; authTimer: ReturnType<typeof setTimeout> };
type PendingResponse = { storeId: string; finish: (response: Response) => void; timer: ReturnType<typeof setTimeout> };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (status: number, body: unknown) => Response.json(body, { status });

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminAuthorized(request: Request, token: string): boolean {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") && constantTimeEqual(value.slice(7), token);
}

function validPublicBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function validPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function pairingAdminPage(defaultUrl: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR Ordering POS approval</title>
<style>body{font:16px system-ui,sans-serif;max-width:540px;margin:8vh auto;padding:24px;color:#e9eef7;background:#101827}h1{font-size:24px}label{display:block;margin:14px 0 5px;color:#bdc9d8}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #44546a;border-radius:8px;background:#0b1220;color:#fff}button{margin-top:18px;padding:11px 16px;border:0;border-radius:8px;background:#3bc3d1;color:#08121b;font-weight:700;cursor:pointer}small{color:#9bacbf}.status{margin-top:14px;min-height:24px}</style>
<h1>Approve a POS device</h1><p>Confirm that this code belongs to the cafe you are pairing.</p>
<label for="code">One-time pairing code</label><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
<label for="store">Store ID</label><input id="store" placeholder="cafe-one" maxlength="64">
<label for="base">Public HTTPS address for this store</label><input id="base" value="${defaultUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" placeholder="https://cafe-one.qr.example.com">
<label for="token">Admin token</label><input id="token" type="password" autocomplete="current-password">
<button id="approve">Approve POS</button><div class="status" id="status" role="status"></div>
<script>const q=new URLSearchParams(location.search);document.querySelector('#code').value=q.get('code')||'';document.querySelector('#approve').onclick=async()=>{const s=document.querySelector('#status');s.textContent='Approving…';try{const r=await fetch('/api/pos/pair/approve',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+document.querySelector('#token').value},body:JSON.stringify({code:document.querySelector('#code').value,store_id:document.querySelector('#store').value,public_base_url:document.querySelector('#base').value})});const d=await r.json();s.textContent=r.ok?'POS paired for '+d.store_id:(d.error||'Approval failed')}catch(e){s.textContent='Could not reach the relay server'}}</script></html>`;
}

export function createRelayApp(options: RelayOptions) {
  const app = new Elysia({ name: "flocafe-qr-ordering-relay" });
  const sockets = new Map<string, RelaySocket>();
  const socketStates = new WeakMap<object, SocketState>();
  const usedNonces = new Map<string, number>();
  const staticCache = new Map<string, { status: number; headers: [string, string][]; body: ArrayBuffer }>();
  let staticCacheBytes = 0;

  const dropStaticCache = (storeId: string) => {
    for (const [key, entry] of staticCache) {
      if (!key.startsWith(`${storeId}:`)) continue;
      staticCacheBytes -= entry.body.byteLength;
      staticCache.delete(key);
    }
  };

  const keepStatic = (key: string, response: Response, body: ArrayBuffer) => {
    if (body.byteLength > STATIC_ENTRY_MAX_BYTES || staticCache.has(key)) return;
    staticCache.set(key, { status: response.status, headers: [...response.headers], body });
    staticCacheBytes += body.byteLength;
    for (const [oldest, entry] of staticCache) {
      if (staticCacheBytes <= STATIC_CACHE_BYTES) break;
      staticCacheBytes -= entry.body.byteLength;
      staticCache.delete(oldest);
    }
  };

  /**
   * Checks a POS signature over `${action}:${subject}:${ts}:${nonce}`: signed within the window
   * and never seen before, so a captured call cannot be replayed.
   */
  const verifySignedCall = (
    publicKey: string,
    action: string,
    subject: string,
    input: Record<string, unknown>,
  ): boolean => {
    const ts = typeof input.ts === "number" ? input.ts : NaN;
    const nonce = typeof input.nonce === "string" ? input.nonce : "";
    const nowMs = Date.now();
    for (const [seen, at] of usedNonces) {
      if (at > nowMs - SIGNED_CALL_WINDOW_MS) break;
      usedNonces.delete(seen);
    }
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > SIGNED_CALL_WINDOW_MS) return false;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || usedNonces.has(nonce)) return false;
    if (typeof input.signature !== "string") return false;
    if (!verifyEd25519(publicKey, `${action}:${subject}:${ts}:${nonce}`, input.signature)) return false;
    usedNonces.set(nonce, nowMs);
    return true;
  };
  // Elysia hands each callback a fresh wrapper around the same Bun socket, so state keys on the socket.
  const socketKey = (ws: unknown): object => ((ws as { raw?: object }).raw ?? ws) as object;
  const pending = new Map<string, PendingResponse>();
  const pendingByStore = new Map<string, number>();

  const failStoreRequests = (storeId: string, status: number) => {
    for (const [id, item] of pending) {
      if (item.storeId !== storeId) continue;
      clearTimeout(item.timer);
      pending.delete(id);
      item.finish(json(status, { error: "POS connection closed", code: "pos_disconnected" }));
    }
    pendingByStore.delete(storeId);
  };

  const clientIpHeader = (options.clientIpHeader ?? "cf-connecting-ip").trim().toLowerCase();
  // Never the client-supplied X-Forwarded-For: the POS rate-limits guests per address, so it must be the real one.
  const clientAddress = (request: Request, server: RequestIpServer): string => {
    const value = clientIpHeader ? request.headers.get(clientIpHeader)?.trim() || "" : server?.requestIP(request)?.address || "";
    return isIP(value) ? value : "";
  };

  const sendToPos = (storeId: string, method: string, payload: QueuedOrderRequest): Promise<Response> => {
    const ws = sockets.get(storeId);
    if (!ws) return Promise.resolve(json(503, { error: "POS is offline", code: "pos_offline" }));
    const current = pendingByStore.get(storeId) || 0;
    if (current >= MAX_IN_FLIGHT_PER_STORE) {
      return Promise.resolve(json(503, { error: "Store is busy", code: "pos_busy" }));
    }
    const id = randomUUID();
    pendingByStore.set(storeId, current + 1);
    return new Promise<Response>((resolve) => {
      const finish = (response: Response) => {
        clearTimeout(timer);
        pending.delete(id);
        pendingByStore.set(storeId, Math.max(0, (pendingByStore.get(storeId) || 1) - 1));
        resolve(response);
      };
      const timer = setTimeout(() => {
        finish(json(504, { error: "POS did not answer in time", code: "pos_timeout" }));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { storeId, timer, finish });
      try {
        ws.send(JSON.stringify({ type: "request", id, method, ...payload }));
      } catch {
        finish(json(503, { error: "POS connection failed", code: "pos_disconnected" }));
      }
    });
  };

  const outbox = options.outbox;
  const reviewResult = { status: 409, body: { code: "order_needs_review" } };
  let orderWorkerBusy = false;
  const deliverOrder = async () => {
    if (!outbox || orderWorkerBusy) return;
    orderWorkerBusy = true;
    try {
      const order = await outbox.claimOrder();
      if (!order) return;
      let result: QueuedOrderResult | null = null;
      if (order.attempts <= MAX_ORDER_ATTEMPTS) {
        const response = await sendToPos(order.storeId, "POST", order.payload);
        const body = record(await response.json().catch(() => null));
        if (
          response.status === 201 && body.success === true &&
          body.idempotency_key === order.key &&
          typeof body.order_number === "string" && body.order_number.trim()
        ) {
          result = { status: 201, body: { success: true, order_number: body.order_number } };
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          // A later validation failure may follow a committed attempt whose reply was lost.
          result = order.attempts === 1 || body.code === "order_rejected"
            ? { status: response.status, body }
            : reviewResult;
        }
      }
      if (!result && order.attempts >= MAX_ORDER_ATTEMPTS) result = reviewResult;
      const delay = 5_000 * 2 ** Math.min(order.attempts - 1, MAX_ORDER_ATTEMPTS - 1);
      await outbox.settleOrder(order, result, delay + randomInt(0, 1_000));
    } catch {
      console.error("QR order outbox worker failed");
    } finally {
      orderWorkerBusy = false;
    }
  };
  let orderWorker: ReturnType<typeof setInterval> | undefined;
  if (outbox) {
    app.onStart(() => {
      orderWorker = setInterval(() => void deliverOrder(), ORDER_WORKER_INTERVAL_MS);
    });
    app.onStop(() => clearInterval(orderWorker));
  }

  const forwardGuestRequest = async ({
    request,
    set,
    server,
  }: {
    request: Request;
    set: { status?: number | string };
    server?: RequestIpServer;
  }) => {
    const url = new URL(request.url);
    const orderStatus = request.method === "POST" && url.pathname === "/api/guest/order/status";
    if ((!orderStatus || !outbox) && !isRelayPathAllowed(request.method, url.pathname)) {
      set.status = 404;
      return { error: "Not found" };
    }
    const clientIp = clientAddress(request, server);
    if (!clientIp) {
      set.status = 400;
      return { error: "Client address unknown", code: "client_ip_missing" };
    }
    const host = request.headers.get("host") || url.host;
    const store = await options.repository.getStoreByHost(host);
    if (!store || !store.active) {
      set.status = 404;
      return { error: "Unknown store" };
    }
    const staticKey =
      request.method.toUpperCase() === "GET" && url.pathname.startsWith("/_next/static/")
        ? `${store.storeId}:${url.pathname}`
        : "";
    const cached = staticKey ? staticCache.get(staticKey) : undefined;
    if (cached) {
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
    }
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_REQUEST_BYTES) {
      set.status = 413;
      return { error: "Request too large" };
    }
    const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_REQUEST_BYTES) {
      set.status = 413;
      return { error: "Request too large" };
    }
    const allowedHeaders: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) allowedHeaders[name] = value;
    }
    const payload = {
      path: `${url.pathname}${url.search}`,
      headers: allowedHeaders,
      client_ip: clientIp,
      body: Buffer.from(body).toString("base64"),
    };

    const method = request.method.toUpperCase();
    if (outbox && method === "POST" && (orderStatus || url.pathname === "/api/guest/order")) {
      const raw = Buffer.from(body).toString("utf8");
      let input: Record<string, unknown>;
      try { input = record(JSON.parse(raw)); } catch { return json(400, { code: "invalid_order" }); }
      const key = input.idempotency_key;
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(key) ||
          typeof input.device_token !== "string" || !input.device_token ||
          typeof input.table_id !== "string" || !input.table_id ||
          !Array.isArray(input.items) || input.items.length === 0) {
        return json(400, { code: "invalid_order" });
      }
      const hash = sha256(raw);
      if (orderStatus) {
        const existing = await outbox.findOrder(store.storeId, key, hash);
        if (!existing || existing.conflict) return json(404, { code: "order_not_found" });
        return existing.result
          ? json(existing.result.status, existing.result.body)
          : json(202, { code: "order_queued" });
      }
      const queued = await outbox.enqueueOrder(store.storeId, key, hash, payload);
      if (!queued) return json(503, { code: "order_queue_full" });
      if (queued.conflict) return json(409, { code: "order_key_conflict" });
      if (queued.result) return json(queued.result.status, queued.result.body);
      return json(202, { code: "order_queued" });
    }
    return sendToPos(store.storeId, method, payload).then(async (response) => {
      if (!response.ok && response.status >= 500) return response;
      const payload = await response.arrayBuffer();
      if (payload.byteLength > MAX_RESPONSE_BYTES) return json(502, { error: "POS response too large" });
      const headers = new Headers(response.headers);
      if (staticKey && response.status === 200) {
        headers.set("cache-control", IMMUTABLE_CACHE_CONTROL);
        const answer = new Response(payload, { status: 200, headers });
        keepStatic(staticKey, answer, payload);
        return answer;
      }
      return new Response(payload, { status: response.status, headers });
    });
  };

  app.get("/healthz", () => ({ status: "ok", service: "qr-ordering-relay" }));
  app.get("/api/admin/order-review", async ({ request }) => {
    if (!adminAuthorized(request, options.adminToken)) return json(401, { error: "Unauthorized" });
    if (!outbox) return json(503, { error: "Order outbox unavailable" });
    return json(200, { orders: await outbox.listOrdersForReview() });
  });
  app.get("/admin/pair", () => new Response(pairingAdminPage(options.publicBaseUrl), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));

  app.post("/api/pos/pair/start", async ({ body, set }) => {
    const input = record(body);
    if (!validPublicKey(input.public_key) || typeof input.device_name !== "string" || input.device_name.trim().length === 0 || input.device_name.length > 80) {
      set.status = 400;
      return { error: "Invalid POS public key or device name" };
    }
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    await options.repository.createPairing({
      id,
      codeHash: sha256(code),
      publicKey: input.public_key,
      deviceName: input.device_name.trim(),
      status: "pending",
      storeId: null,
      publicBaseUrl: null,
      expiresAt,
    });
    return { pairing_id: id, code, expires_at: expiresAt };
  });

  app.post("/api/pos/pair/status", async ({ body, set }) => {
    const input = record(body);
    const id = typeof input.pairing_id === "string" ? input.pairing_id : "";
    const pairing = id ? await options.repository.getPairing(id) : null;
    if (!pairing || !verifySignedCall(pairing.publicKey, "pair", id, input)) {
      set.status = 403;
      return { error: "Invalid pairing signature" };
    }
    if (pairing.status === "pending" && Date.parse(pairing.expiresAt) <= Date.now()) return { status: "expired" };
    if (pairing.status !== "approved" || !pairing.storeId || !pairing.publicBaseUrl) return { status: pairing.status };
    return { status: "approved", store_id: pairing.storeId, public_base_url: pairing.publicBaseUrl };
  });

  app.post("/api/pos/pair/approve", async ({ request, body, set }) => {
    if (!options.adminToken || !adminAuthorized(request, options.adminToken)) {
      set.status = 401;
      return { error: "Admin authorization required" };
    }
    const input = record(body);
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const storeId = typeof input.store_id === "string" ? input.store_id.trim() : "";
    const publicBaseUrl = validPublicBaseUrl(input.public_base_url ?? options.publicBaseUrl);
    if (!/^\d{6}$/.test(code) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(storeId) || !publicBaseUrl) {
      set.status = 400;
      return { error: "Enter a six-digit code, valid store ID, and HTTPS address" };
    }
    const approved = await options.repository.approvePairing(sha256(code), storeId, publicBaseUrl);
    if (!approved) {
      set.status = 404;
      return { error: "Pairing code expired or already used" };
    }
    return { status: "approved", store_id: storeId, public_base_url: publicBaseUrl };
  });

  app.post("/api/pos/unpair", async ({ body, set }) => {
    const input = record(body);
    const storeId = typeof input.store_id === "string" ? input.store_id : "";
    const store = storeId ? await options.repository.getStore(storeId) : null;
    if (!store || !verifySignedCall(store.publicKey, "unpair", storeId, input)) {
      set.status = 403;
      return { error: "Invalid unpair signature" };
    }
    await options.repository.unpairStore(storeId);
    dropStaticCache(storeId);
    sockets.get(storeId)?.close(1008, "POS unpaired");
    return { success: true };
  });

  app.ws("/api/pos/tunnel", {
    open(ws) {
      const request = (ws as unknown as RelaySocket).data.request;
      const storeId = request.headers.get("x-flo-store") || "";
      const nonce = randomBytes(16).toString("hex");
      const authTimer = setTimeout(() => {
        const state = socketStates.get(socketKey(ws));
        if (state && !state.authenticated) ws.close(1008, "Authentication timeout");
      }, 5_000);
      socketStates.set(socketKey(ws), { storeId, nonce, authenticated: false, authTimer });
      ws.send(JSON.stringify({ type: "challenge", nonce }));
    },
    async message(ws, rawMessage) {
      const socket = ws as unknown as RelaySocket;
      const state = socketStates.get(socketKey(ws));
      if (!state) return ws.close(1008, "Missing connection state");
      let message: Record<string, unknown>;
      try {
        // Elysia hands over a JSON text frame already parsed; raw text and binary frames are parsed here.
        if (typeof rawMessage === "string") message = record(JSON.parse(rawMessage));
        else if (rawMessage instanceof ArrayBuffer || ArrayBuffer.isView(rawMessage)) {
          message = record(JSON.parse(Buffer.from(rawMessage as ArrayBuffer).toString("utf8")));
        } else message = record(rawMessage);
      } catch {
        return ws.close(1008, "Invalid message");
      }
      if (!state.authenticated) {
        if (message.type !== "auth" || message.store_id !== state.storeId || !state.storeId) {
          ws.send(JSON.stringify({ type: "error", code: "unknown_store" }));
          return ws.close(1008, "Invalid authentication");
        }
        const store = await options.repository.getStore(state.storeId);
        if (!store?.active || typeof message.signature !== "string" || !verifyEd25519(store.publicKey, `tunnel:${state.nonce}`, message.signature)) {
          ws.send(JSON.stringify({ type: "error", code: "unknown_store" }));
          return ws.close(1008, "Invalid authentication");
        }
        clearTimeout(state.authTimer);
        state.authenticated = true;
        const prior = sockets.get(state.storeId);
        if (prior && socketKey(prior) !== socketKey(socket)) prior.close(4001, "Replaced by a newer POS connection");
        sockets.set(state.storeId, socket);
        ws.send(JSON.stringify({ type: "ready" }));
        return;
      }
      if (message.type !== "response" || typeof message.id !== "string") return;
      const item = pending.get(message.id);
      if (!item || item.storeId !== state.storeId) return;
      const status = typeof message.status === "number" && message.status >= 100 && message.status <= 599 ? message.status : 502;
      const headers = new Headers();
      const suppliedHeaders = record(message.headers);
      for (const name of RESPONSE_HEADERS) {
        const value = suppliedHeaders[name];
        if (typeof value === "string") headers.set(name, value);
      }
      let bytes = new Uint8Array();
      if (typeof message.body === "string") {
        try { bytes = Uint8Array.from(Buffer.from(message.body, "base64")); } catch { bytes = new Uint8Array(); }
      }
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        item.finish(json(502, { error: "POS response too large" }));
      } else {
        item.finish(new Response(bytes, { status, headers }));
      }
    },
    close(ws) {
      const state = socketStates.get(socketKey(ws));
      if (!state) return;
      clearTimeout(state.authTimer);
      socketStates.delete(socketKey(ws));
      if (state.authenticated && socketKey(sockets.get(state.storeId)) === socketKey(ws)) {
        sockets.delete(state.storeId);
        failStoreRequests(state.storeId, 503);
      }
    },
  });

  app.all("/api/guest/table", forwardGuestRequest);
  app.all("/api/guest/menu", forwardGuestRequest);
  app.all("/api/guest/order", forwardGuestRequest);
  app.post("/api/guest/order/status", forwardGuestRequest);
  app.all("/api/server-app/info", forwardGuestRequest);
  app.all("/server-standalone/*", forwardGuestRequest);
  app.all("/_next/static/*", forwardGuestRequest);
  app.all("/icons/*", forwardGuestRequest);
  app.all("/fonts/*", forwardGuestRequest);
  app.all("/favicon.ico", forwardGuestRequest);
  app.all("/*", ({ set }) => {
    set.status = 404;
    return { error: "Not found" };
  });

  app.onError(({ code, set }) => {
    set.status = code === "VALIDATION" ? 400 : 500;
    return { error: "Relay request failed" };
  });

  return app;
}
