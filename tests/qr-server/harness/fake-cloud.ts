/**
 * A stand-in for the cloud end of the delivery transport: it authenticates the connector, sends
 * envelopes and waits for acks. Used by the L1.5 suite so the contract can be tested without Docker.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { DeliveryAck, DeliveryEnvelope, parseAck } from './delivery';

interface Pending {
  resolve: (ack: DeliveryAck) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface FakeCloudOptions {
  token: string;
  storeId: string;
  ackTimeoutMs?: number;
}

export class FakeCloud {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private ready: Promise<void>;
  private markReady: () => void = () => {};
  private readySeen = false;

  constructor(private options: FakeCloudOptions) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  async listen(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => this.wss!.once('listening', () => resolve()));
    this.wss.on('connection', (socket, request) =>
      this.onConnection(socket, request.headers.authorization),
    );
  }

  get url(): string {
    const address = this.wss!.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/api/connector/stream`;
  }

  private onConnection(socket: WebSocket, authorization: string | undefined): void {
    if (authorization !== `Bearer ${this.options.token}`) {
      socket.close(4001, 'unauthorized');
      return;
    }
    this.socket = socket;
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', () => {
      if (socket === this.socket) this.socket = null;
    });
    socket.send(
      JSON.stringify({
        type: 'ready',
        storeId: this.options.storeId,
        serverTime: new Date().toISOString(),
      }),
    );
    this.readySeen = true;
    this.markReady();
  }

  private onMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.type === 'ack') {
      let ack: DeliveryAck;
      try {
        ack = parseAck(message.ack);
      } catch {
        return;
      }
      const pending = this.pending.get(ack.deliveryId);
      if (!pending) return;
      this.pending.delete(ack.deliveryId);
      clearTimeout(pending.timer);
      pending.resolve(ack);
    } else if (message.type === 'error' && typeof message.deliveryId === 'string') {
      const pending = this.pending.get(message.deliveryId);
      if (!pending) return;
      this.pending.delete(message.deliveryId);
      clearTimeout(pending.timer);
      const error = new Error(String(message.code ?? 'delivery_error'));
      error.name = 'DeliveryError';
      pending.reject(error);
    }
  }

  waitReady(timeoutMs = 3_000): Promise<void> {
    if (this.readySeen) return Promise.resolve();
    return Promise.race([
      this.ready,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('connector_ready_timeout')), timeoutMs),
      ),
    ]);
  }

  send(envelope: DeliveryEnvelope): Promise<DeliveryAck> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('not_connected'));
    const timeout = this.options.ackTimeoutMs ?? 3_000;
    return new Promise<DeliveryAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.deliveryId);
        reject(new Error('ack_timeout'));
      }, timeout);
      this.pending.set(envelope.deliveryId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: 'deliver', envelope }));
    });
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('cloud_closed'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}
