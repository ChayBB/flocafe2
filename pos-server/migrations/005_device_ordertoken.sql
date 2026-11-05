-- จำเครื่องลูกค้า: clientId (สุ่มในเบราว์เซอร์, เก็บเฉพาะ hash) → สแกนซ้ำ/กู้คืนไม่กินโควตาจำนวนเครื่อง
alter table guest_device add column client_id_hash text;
create unique index guest_device_client on guest_device (bill_id, client_id_hash)
  where revoked_at is null and client_id_hash is not null;

-- ตรวจย้อนหลังได้ว่าออเดอร์มาจากเครื่องไหน (ไม่ลบข้อมูลเมื่อบิลปิด)
alter table orders add column device_id uuid references guest_device(id);

-- Order token แบบใช้ครั้งเดียว (เปิดด้วย settings.order_token): ผูกกับ device, อายุสั้น, ใช้แล้วหมดทันทีแบบ atomic
create table order_token (
  id         bigserial primary key,
  tenant_id  uuid not null references tenant(id),
  device_id  uuid not null references guest_device(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table order_token enable row level security;
create policy tenant_isolation on order_token
  using (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid);
grant select, insert, update on order_token to pos_app;
grant usage on sequence order_token_id_seq to pos_app;
grant update (device_id) on orders to pos_app;
