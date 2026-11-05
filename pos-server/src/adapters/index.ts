/**
 * Adapter ภายนอก (ERPNext / FloCafe / เครื่องพิมพ์ครัว) ใช้ interface เดียวกัน
 * สลับหรือเพิ่มได้โดยไม่แตะ core. ตอนนี้เป็น stub ที่แค่ log — ใส่การเรียกจริงใน handle()
 */
export interface OutboxJob {
  id: number;
  tenantId: string;
  topic: string;
  payload: Record<string, unknown>;
}

export interface Adapter {
  name: string;
  topics: string[];
  handle(job: OutboxJob): Promise<void>;
}

export const logAdapter: Adapter = {
  name: "log",
  topics: ["order.created", "order.status", "bill.closed"],
  async handle(job) {
    console.log(JSON.stringify({ level: "info", adapter: "log", topic: job.topic, tenant: job.tenantId, payload: job.payload }));
  },
};

// TODO: erpnextAdapter (bill.closed → Sales Invoice), flocafeAdapter (order.created → POS), kitchenPrinterAdapter
export const adapters: Adapter[] = [logAdapter];
