import { sql } from "./db.ts";

// ---- ในหน่วยความจำ (ต่อ process): สำหรับ limit หลวม ๆ ทุกคำขอ ----
const mem = new Map<string, { n: number; reset: number }>();

export function memLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const e = mem.get(key);
  if (!e || e.reset <= now) {
    mem.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  e.n += 1;
  return e.n <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem) if (v.reset <= now) mem.delete(k);
}, 60_000).unref();

// ---- ใน Postgres (ร่วมกันทุก process): ใช้ connection แยกจาก transaction ของคำขอ
//      จึง commit ทันทีแม้คำขอนั้นจะ rollback (สำคัญกับการนับ PIN ผิด) ----
const windowStart = (windowSec: number) => {
  const w = windowSec * 1000;
  return new Date(Math.floor(Date.now() / w) * w);
};

/** นับ 1 ครั้ง แล้วบอกว่ายังไม่เกิน limit หรือไม่ */
export async function dbLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const n = await dbHit(key, windowSec);
  return n <= limit;
}

export async function dbHit(key: string, windowSec: number): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    insert into rate_limit (key, window_start, n) values (${key}, ${windowStart(windowSec)}, 1)
    on conflict (key, window_start) do update set n = rate_limit.n + 1
    returning n`;
  return r?.n ?? 0;
}

/** ดูจำนวนปัจจุบันโดยไม่นับเพิ่ม */
export async function dbCount(key: string, windowSec: number): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select n from rate_limit where key = ${key} and window_start = ${windowStart(windowSec)}`;
  return r?.n ?? 0;
}

export async function cleanupRateLimit(): Promise<void> {
  await sql`delete from rate_limit where window_start < now() - interval '2 hours'`;
  await sql`delete from order_token where created_at < now() - interval '1 day'`;
}
