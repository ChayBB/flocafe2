-- epoch ต่อโต๊ะ: เพิ่มทุกครั้งที่เช็คบิล/ย้าย/ยกเลิก/reset/พนักงานสั่งหมุน
-- device token ผูกกับ epoch ตอนออก → epoch เปลี่ยนแล้วใช้ต่อไม่ได้ (defense-in-depth นอกเหนือจาก revoke)
alter table dining_table add column epoch int not null default 1;
alter table guest_device add column epoch int not null default 1;

create table table_audit (
  id bigserial primary key,
  tenant_id uuid not null references tenant(id),
  table_id uuid not null,
  bill_id uuid,
  epoch int not null,
  action text not null check (action in ('paid','cancelled','moved','daily_reset','manual_rotate')),
  reason text,
  actor uuid,
  at timestamptz not null default now(),
  foreign key (table_id, tenant_id) references dining_table(id, tenant_id)
);
create index table_audit_table on table_audit (table_id, id desc);

alter table table_audit enable row level security;
create policy tenant_isolation on table_audit
  using (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant', true), '')::uuid);

grant select, insert on table_audit to pos_app;
grant usage on sequence table_audit_id_seq to pos_app;
