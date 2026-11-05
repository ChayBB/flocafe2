import postgres from "postgres";
import type { PairingRecord, RelayRepository, RelayStoreRecord } from "./repository";

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

export class PostgresRelayRepository implements RelayRepository {
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
}
