-- ส่งต่อออเดอร์ไป POS ในร้าน (FloCafe) ผ่าน connector ที่ดึงงาน (pull) ออกไปจากร้าน → ไม่ต้องเปิดพอร์ตเข้าร้าน
alter table staff_user drop constraint if exists staff_user_role_check;
alter table staff_user add constraint staff_user_role_check check (role in ('kitchen', 'cashier', 'manager', 'connector'));

alter table menu_item add column pos_product_id text;      -- id สินค้าใน FloCafe
alter table dining_table add column pos_table_id text;     -- id โต๊ะใน FloCafe
alter table bill add column pos_order_id text;             -- ออเดอร์เปิดของบิลนี้ใน FloCafe (สั่งรอบถัดไป = เพิ่มรายการเข้าออเดอร์นี้)

create table pos_forward (
  id           bigserial primary key,
  tenant_id    uuid not null references tenant(id),
  order_id     uuid not null,
  bill_id      uuid not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts     int not null default 0,
  lease_until  timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  unique (tenant_id, order_id),
  foreign key (order_id, tenant_id) references orders(id, tenant_id)
);
create index pos_forward_pending on pos_forward (tenant_id, id) where status = 'pending';

alter table pos_forward enable row level security;
create policy tenant_isolation on pos_forward
  using (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid);
grant select, insert, update on pos_forward to pos_app;
grant usage on sequence pos_forward_id_seq to pos_app;
grant update (pos_order_id) on bill to pos_app;
