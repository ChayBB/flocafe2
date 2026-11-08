/**
 * A stand-in for the in-store connector: dedups by (store, order), replays the stored ack, and can
 * drop one ack to simulate the lost-ack window.
 */
import WebSocket from 'ws';
import {
  DeliveryAck,
  DeliveryContractError,
  DeliveryEnvelope,
  PROTOCOL_VERSION,
  assertDeliverable,
  dedupKey,
  parseEnvelope,
} from './delivery';

export interface PosResult {
  posOrderId: string;
  posItemIds: string[];
}

export interface FakeConnectorOptions {
  url: string;
  token: string;
  storeId: string;
  pos: (envelope: DeliveryEnvelope) => Promise<PosResult>;
  inbox?: Map<string, PosResult>;
}

export class FakeConnector {
  readonly inbox: Map<string, PosResult>;
  posCalls = 0;
  deliveries = 0;
  dropNextAck = false;
  private socket: WebSocket | null = null;

  constructor(private options: FakeConnectorOptions) {
    this.inbox = options.inbox ?? new Map();
  }

  connect(timeoutMs = 3_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: { authorization: `Bearer ${this.options.token}` },
      });
      this.socket = socket;
      let ready = false;
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('connect_timeout'));
      }, timeoutMs);
      socket.on('message', (data) => {
        void this.onMessage(data.toString(), () => {
          ready = true;
          clearTimeout(timer);
          resolve();
        });
      });
      socket.on('close', (code) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`closed_${code}`));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        if (!ready) reject(error);
      });
    });
  }

  private async onMessage(text: string, onReady: () => void): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'ready') {
      onReady();
      return;
    }
    if (message.type === 'ping') {
      this.send({ type: 'pong', at: new Date().toISOString() });
      return;
    }
    if (message.type !== 'deliver') return;
    await this.onDeliver(message.envelope);
  }

  private async onDeliver(raw: unknown): Promise<void> {
    let envelope: DeliveryEnvelope;
    try {
      envelope = parseEnvelope(raw);
      assertDeliverable(envelope, this.options.storeId);
    } catch (error) {
      const code = error instanceof DeliveryContractError ? error.code : 'invalid_envelope';
      const id =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).deliveryId
          : undefined;
      this.send({ type: 'error', deliveryId: typeof id === 'string' ? id : undefined, code });
      return;
    }

    const key = dedupKey(envelope.storeId, envelope.orderId);
    let result = this.inbox.get(key);
    if (!result) {
      this.posCalls += 1;
      result = await this.options.pos(envelope);
      this.inbox.set(key, result);
    }
    this.deliveries += 1;

    const ack: DeliveryAck = {
      v: PROTOCOL_VERSION,
      deliveryId: envelope.deliveryId,
      storeId: envelope.storeId,
      orderId: envelope.orderId,
      ok: true,
      posOrderId: result.posOrderId,
      posItemIds: result.posItemIds,
      ackedAt: new Date().toISOString(),
    };
    if (this.dropNextAck) {
      this.dropNextAck = false;
      return;
    }
    this.send({ type: 'ack', ack });
  }

  private send(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
