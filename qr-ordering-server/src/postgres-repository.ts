import postgres from "postgres";
import type { PairingRecord, RelayRepository, RelayStoreRecord } from "./repository";
import type { OrderOutbox, QueuedOrder, QueuedOrderRequest, QueuedOrderResult } from "./repository";

const pairingFromRow = (row: Record<string, unknown>): PairingRecord => ({
  id: String(row.id),
  codeHash: String(row.code_hash),
  publicKey: String(row.public_key),
  deviceName: String(row.device_name),
  status: String(row.status) as PairingRecord["status"],
  storeId: row.store_id == null ? null : String(row.store_id),
  publicBaseUrl: row.public_base_url == null ? null : String(row.public_base_url),
  expiresAt: new Date(String(row.expires_at)).toISOString(),
});

export class PostgresRelayRepository implements RelayRepository, OrderOutbox {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10, idle_timeout: 30, connect_timeout: 10 });
  }

  async createPairing(record: PairingRecord): Promise<void> {
    await this.sql`
      INSERT INTO qr_pairings (id, code_hash, public_key, device_name, status, expires_at)
      VALUES (${record.id}, ${record.codeHash}, ${record.publicKey}, ${record.deviceName}, ${record.status}, ${record.expiresAt})
    `;
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const [row] = await this.sql`SELECT * FROM qr_pairings WHERE id = ${id} LIMIT 1`;
    return row ? pairingFromRow(row) : null;
  }

  async approvePairing(
    codeHash: string,
    storeId: string,
    publicBaseUrl: string,
  ): Promise<PairingRecord | null> {
    return this.sql.begin(async (tx) => {
      const [pending] = await tx`
        SELECT * FROM qr_pairings
        WHERE code_hash = ${codeHash} AND status = 'pending' AND expires_at > now()
        FOR UPDATE
      `;
      if (!pending) return null;
      await tx`
        INSERT INTO qr_stores (store_id, public_key, device_name, public_base_url, public_host, active)
        VALUES (${storeId}, ${pending.public_key}, ${pending.device_name}, ${publicBaseUrl}, ${new URL(publicBaseUrl).host.toLowerCase()}, true)
        ON CONFLICT (store_id) DO UPDATE SET
          public_key = EXCLUDED.public_key,
          device_name = EXCLUDED.device_name,
          public_base_url = EXCLUDED.public_base_url,
          public_host = EXCLUDED.public_host,
          active = true,
          updated_at = now()
      `;
      const [approved] = await tx`
        UPDATE qr_pairings
        SET status = 'approved', store_id = ${storeId}, public_base_url = ${publicBaseUrl}, approved_at = now()
        WHERE id = ${pending.id}
        RETURNING *
      `;
      return approved ? pairingFromRow(approved) : null;
    });
  }

  async getStore(storeId: string): Promise<RelayStoreRecord | null> {
    const [row] = await this.sql`
      SELECT store_id, public_key, device_name, public_base_url, active
      FROM qr_stores WHERE store_id = ${storeId} LIMIT 1
    `;
    if (!row) return null;
    return {
      storeId: String(row.store_id),
      publicKey: String(row.public_key),
      deviceName: String(row.device_name),
      publicBaseUrl: String(row.public_base_url),
      active: Boolean(row.active),
    };
  }

  async getStoreByHost(host: string): Promise<RelayStoreRecord | null> {
    const [row] = await this.sql`
      SELECT store_id, public_key, device_name, public_base_url, active
      FROM qr_stores
      WHERE lower(public_host) = lower(${host}) AND active = true
      LIMIT 1
    `;
    if (!row) return null;
    return {
      storeId: String(row.store_id),
      publicKey: String(row.public_key),
      deviceName: String(row.device_name),
      publicBaseUrl: String(row.public_base_url),
      active: Boolean(row.active),
    };
  }

  async unpairStore(storeId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE qr_stores SET active = false, updated_at = now()
      WHERE store_id = ${storeId} AND active = true
      RETURNING store_id
    `;
    return result.length > 0;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async findOrder(storeId: string, key: string, hash: string) {
    const [row] = await this.sql`
      SELECT request_hash, result::text AS result FROM qr_order_outbox
      WHERE store_id = ${storeId} AND order_key = ${key}
    `;
    return row ? {
      conflict: row.request_hash !== hash,
      result: row.result === null ? null : JSON.parse(String(row.result)) as QueuedOrderResult,
    } : null;
  }

  async enqueueOrder(storeId: string, key: string, hash: string, payload: QueuedOrderRequest) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${storeId}))`;
      await tx`
        INSERT INTO qr_order_outbox (store_id, order_key, request_hash, payload)
        SELECT ${storeId}, ${key}, ${hash}, ${JSON.stringify(payload)}::text::jsonb
        WHERE (SELECT count(*) FROM qr_order_outbox
               WHERE store_id = ${storeId} AND result IS NULL) < 100
        ON CONFLICT (store_id, order_key) DO NOTHING
      `;
      const [row] = await tx`
        SELECT request_hash, result::text AS result FROM qr_order_outbox
        WHERE store_id = ${storeId} AND order_key = ${key}
      `;
      return row
        ? { conflict: row.request_hash !== hash, result: row.result === null ? null : JSON.parse(String(row.result)) as QueuedOrderResult }
        : null;
    });
  }

  async claimOrder(): Promise<QueuedOrder | null> {
    const [row] = await this.sql`
      WITH next_order AS (
        SELECT store_id, order_key FROM qr_order_outbox
        WHERE result IS NULL AND available_at <= now()
        ORDER BY available_at
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE qr_order_outbox AS job
      SET attempts = attempts + 1, available_at = now() + interval '45 seconds'
      FROM next_order
      WHERE job.store_id = next_order.store_id AND job.order_key = next_order.order_key
      RETURNING job.store_id, job.order_key, job.attempts, job.payload::text AS payload
    `;
    return row ? {
      storeId: String(row.store_id),
      key: String(row.order_key),
      attempts: Number(row.attempts),
      payload: JSON.parse(String(row.payload)) as QueuedOrderRequest,
    } : null;
  }

  async settleOrder(order: QueuedOrder, result: QueuedOrderResult | null, delayMs: number) {
    await this.sql`
      UPDATE qr_order_outbox
      SET result = ${result ? JSON.stringify(result) : null}::text::jsonb,
          payload = CASE WHEN ${result !== null} THEN NULL ELSE payload END,
          available_at = now() + ${delayMs}::integer * interval '1 millisecond'
      WHERE store_id = ${order.storeId} AND order_key = ${order.key}
        AND attempts = ${order.attempts} AND result IS NULL
    `;
  }

  async listOrdersForReview() {
    return this.sql<{ store_id: string; order_key: string; attempts: number }[]>`
      SELECT store_id, order_key, attempts FROM qr_order_outbox
      WHERE result->'body'->>'code' = 'order_needs_review'
      ORDER BY available_at DESC LIMIT 100
    `;
  }
}
