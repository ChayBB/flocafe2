/**
 * A stand-in for the QR-ordering relay server, speaking the POS side of the protocol in
 * main/services/qr-relay.ts: pairing by code, signed status checks, and a tunnel that carries
 * customer requests to the POS. Used by the backend test and the browser test.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

function verify(publicKey, text, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(String(signature), 'base64url'));
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

async function createFakeQrRelay() {
  const pairings = new Map();
  const stores = new Map();
  const unpaired = [];
  let tunnel = null;
  let tunnelWaiters = [];
  const pending = new Map();

  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && req.url === '/api/pos/pair/start') {
      const id = crypto.randomUUID();
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      pairings.set(id, { id, code, publicKey: body.public_key, deviceName: body.device_name, status: 'pending' });
      return json(200, { pairing_id: id, code, expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    if (req.method === 'POST' && req.url === '/api/pos/pair/status') {
      const pairing = pairings.get(body.pairing_id);
      if (!pairing || !verify(pairing.publicKey, `pair:${pairing.id}`, body.signature)) {
        return json(403, { error: 'bad signature' });
      }
      if (pairing.status !== 'approved') return json(200, { status: pairing.status });
      return json(200, { status: 'approved', store_id: pairing.storeId, public_base_url: pairing.publicBaseUrl });
    }
    if (req.method === 'POST' && req.url === '/api/pos/unpair') {
      const store = stores.get(body.store_id);
      if (store && verify(store.publicKey, `unpair:${body.store_id}`, body.signature)) {
        stores.delete(body.store_id);
        unpaired.push(body.store_id);
      }
      return json(200, { success: true });
    }
    json(404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ server, path: '/api/pos/tunnel' });
  wss.on('connection', (ws, req) => {
    const storeId = req.headers['x-flo-store'];
    const nonce = crypto.randomBytes(16).toString('hex');
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.type === 'auth') {
        const store = stores.get(storeId);
        if (!store || message.store_id !== storeId || !verify(store.publicKey, `tunnel:${nonce}`, message.signature)) {
          ws.send(JSON.stringify({ type: 'error', code: 'unknown_store' }));
          ws.close();
          return;
        }
        tunnel = ws;
        ws.send(JSON.stringify({ type: 'ready' }));
        tunnelWaiters.forEach((resolve) => resolve());
        tunnelWaiters = [];
      } else if (message.type === 'response') {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        waiter?.({ status: message.status, headers: message.headers, body: Buffer.from(message.body || '', 'base64') });
      }
    });
    ws.on('close', () => {
      if (tunnel === ws) tunnel = null;
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    pairings,
    unpaired,
    /** The relay admin approving a code, as the Admin Panel would. */
    approve(code, { storeId = `store-${code}`, publicBaseUrl = 'https://shop.order.example.com' } = {}) {
      const pairing = [...pairings.values()].find((entry) => entry.code === code);
      if (!pairing) throw new Error(`no pairing for code ${code}`);
      Object.assign(pairing, { status: 'approved', storeId, publicBaseUrl });
      stores.set(storeId, { publicKey: pairing.publicKey });
      return pairing;
    },
    forgetStore(storeId) {
      stores.delete(storeId);
    },
    waitForTunnel(timeoutMs = 10_000) {
      if (tunnel) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tunnel did not connect')), timeoutMs);
        tunnelWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    get connected() {
      return Boolean(tunnel);
    },
    /** A customer request arriving at the relay, passed down the tunnel. */
    request(method, path, { headers = {}, body, clientIp = '203.0.113.7' } = {}) {
      if (!tunnel) return Promise.reject(new Error('no tunnel'));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no response for ${path}`)), 15_000);
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        tunnel.send(
          JSON.stringify({
            type: 'request',
            id,
            method,
            path,
            headers,
            client_ip: clientIp,
            body: body === undefined ? '' : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64'),
          }),
        );
      });
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createFakeQrRelay };
