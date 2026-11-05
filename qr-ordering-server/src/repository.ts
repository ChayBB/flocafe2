export type PairingStatus = "pending" | "approved" | "rejected" | "expired";

export interface PairingRecord {
  id: string;
  codeHash: string;
  publicKey: string;
  deviceName: string;
  status: PairingStatus;
  storeId: string | null;
  publicBaseUrl: string | null;
  expiresAt: string;
}

export interface RelayStoreRecord {
  storeId: string;
  publicKey: string;
  deviceName: string;
  publicBaseUrl: string;
  active: boolean;
}

export interface RelayRepository {
  createPairing(record: PairingRecord): Promise<void>;
  getPairing(id: string): Promise<PairingRecord | null>;
  approvePairing(codeHash: string, storeId: string, publicBaseUrl: string): Promise<PairingRecord | null>;
  getStore(storeId: string): Promise<RelayStoreRecord | null>;
  getStoreByHost(host: string): Promise<RelayStoreRecord | null>;
  unpairStore(storeId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class MemoryRelayRepository implements RelayRepository {
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly stores = new Map<string, RelayStoreRecord>();

  async createPairing(record: PairingRecord): Promise<void> {
    this.pairings.set(record.id, { ...record });
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const pairing = this.pairings.get(id);
    return pairing ? { ...pairing } : null;
  }

  async approvePairing(
    codeHash: string,
    storeId: string,
    publicBaseUrl: string,
  ): Promise<PairingRecord | null> {
    const pairing = [...this.pairings.values()].find(
      (candidate) => candidate.codeHash === codeHash && candidate.status === "pending",
    );
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) return null;
    pairing.status = "approved";
    pairing.storeId = storeId;
    pairing.publicBaseUrl = publicBaseUrl;
    this.stores.set(storeId, {
      storeId,
      publicKey: pairing.publicKey,
      deviceName: pairing.deviceName,
      publicBaseUrl,
      active: true,
    });
    return { ...pairing };
  }

  async getStore(storeId: string): Promise<RelayStoreRecord | null> {
    const store = this.stores.get(storeId);
    return store ? { ...store } : null;
  }

  async getStoreByHost(host: string): Promise<RelayStoreRecord | null> {
    for (const store of this.stores.values()) {
      try {
        if (new URL(store.publicBaseUrl).host.toLowerCase() === host.toLowerCase() && store.active) {
          return { ...store };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async unpairStore(storeId: string): Promise<boolean> {
    const store = this.stores.get(storeId);
    if (!store) return false;
    store.active = false;
    this.stores.set(storeId, store);
    return true;
  }
}
