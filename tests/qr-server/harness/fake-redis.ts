/**
 * In-memory stand-in for the Redis wake-up channel. It behaves like a list plus leases, not like a
 * database: duplicate wake-ups are allowed on purpose, so tests prove the worker (not the queue) dedups.
 */

export interface WakeEntry {
  seq: number;
  deliveryId: string;
}

export interface ClaimedEntry extends WakeEntry {
  leaseUntil: number;
  attempts: number;
}

export class FakeWakeQueue {
  private queued: WakeEntry[] = [];
  private inflight = new Map<number, ClaimedEntry>();
  private attempts = new Map<string, number>();
  private seq = 0;

  enqueue(deliveryId: string): void {
    this.queued.push({ seq: ++this.seq, deliveryId });
  }

  /** Returns a queued entry, or an in-flight entry whose lease expired. */
  claim(leaseMs: number, now: number = Date.now()): ClaimedEntry | null {
    const next = this.queued.shift();
    if (next) return this.start(next, leaseMs, now);
    for (const entry of this.inflight.values()) {
      if (entry.leaseUntil <= now) {
        entry.leaseUntil = now + leaseMs;
        entry.attempts += 1;
        this.attempts.set(entry.deliveryId, entry.attempts);
        this.inflight.set(entry.seq, entry);
        return entry;
      }
    }
    return null;
  }

  private start(entry: WakeEntry, leaseMs: number, now: number): ClaimedEntry {
    const attempts = (this.attempts.get(entry.deliveryId) ?? 0) + 1;
    this.attempts.set(entry.deliveryId, attempts);
    const claimed: ClaimedEntry = { ...entry, leaseUntil: now + leaseMs, attempts };
    this.inflight.set(entry.seq, claimed);
    return claimed;
  }

  ack(entry: ClaimedEntry): void {
    this.inflight.delete(entry.seq);
  }

  depth(now: number = Date.now()): number {
    let expired = 0;
    for (const entry of this.inflight.values()) if (entry.leaseUntil <= now) expired += 1;
    return this.queued.length + this.inflight.size - expired;
  }

  expired(now: number = Date.now()): ClaimedEntry[] {
    return [...this.inflight.values()].filter((entry) => entry.leaseUntil <= now);
  }
}
