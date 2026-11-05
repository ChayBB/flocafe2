import { sql } from "./db.ts";
import { menuCache } from "./cache.ts";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

interface Sub {
  billId?: string; // มี = ฝั่งลูกค้า (รับเฉพาะ event ของบิลตัวเอง) ไม่มี = ฝั่งพนักงาน
  send: (data: string) => void;
  close: () => void;
}
const subs = new Map<string, Set<Sub>>();

/** LISTEN เดียวต่อ process แล้วแจกต่อให้ SSE ของแต่ละร้าน */
export async function startHub(): Promise<void> {
  await sql.listen("pos_events", (payload) => {
    let m: { t: string; type: string; id?: string; b?: string; r?: string };
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (m.type === "menu.changed") menuCache.delete(m.t);
    const set = subs.get(m.t);
    if (!set) return;
    const data = JSON.stringify({ type: m.type, id: m.id, reason: m.r });
    for (const s of [...set]) {
      if (s.billId) {
        if (m.b !== s.billId) continue;
        s.send(data);
        // บิลปิด/ย้าย/ยกเลิก/reset ทุกกรณีมาทาง bill.closed = ตัดการเชื่อมต่อลูกค้าทันที
        if (m.type === "bill.closed") s.close();
      } else s.send(data);
    }
  });
}

export function sseResponse(tenantId: string, request: Request, o: { billId?: string } = {}): Response {
  let set = subs.get(tenantId);
  if (!set) subs.set(tenantId, (set = new Set()));
  const staffCount = [...set].filter((s) => !s.billId).length;
  const guestCount = set.size - staffCount;
  if (o.billId ? guestCount >= config.limits.sseGuestMaxPerTenant : staffCount >= config.limits.sseStaffMax)
    throw new HttpError(429, "too_many_streams");
  const mySet = set;

  const enc = new TextEncoder();
  let cleanup = () => {};
  let closeStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      const sub: Sub = { billId: o.billId, send: (data) => send(`data: ${data}\n\n`), close: () => closeStream() };
      mySet.add(sub);
      const hb = setInterval(() => send(": hb\n\n"), 15_000);
      cleanup = () => {
        clearInterval(hb);
        mySet.delete(sub);
        if (mySet.size === 0) subs.delete(tenantId);
      };
      closeStream = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
      send("retry: 3000\n\n: connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
