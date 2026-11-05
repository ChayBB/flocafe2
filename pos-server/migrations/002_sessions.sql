-- Phase 1–6: session = bill, PIN, device token, invite, daily reset
-- ทุกอย่างเป็นการเพิ่ม (backward-compatible) รันคู่กับโค้ดเวอร์ชันก่อนหน้าได้ชั่วคราว

alter table tenant
  add column tz            text    not null default 'Asia/Bangkok',
  add column reset_enabled boolean not null default true,
  add column reset_time    time    not null default '07:00',
  add column last_reset_on date;       -- วันที่ (ตาม tz ของร้าน) ที่ reset ไปแล้ว กัน reset ซ้ำ

alter table bill
  add column pin              text check (pin ~ '^[0-9]{4}$'),   -- null = ร้านที่ปิด require_pin (เปิดบิลอัตโนมัติ)
  add column closed_reason    text check (closed_reason in ('paid', 'cancelled', 'moved', 'daily_reset')),
  add column moved_to_bill_id uuid references bill(id),
  add column opened_by        uuid;                              -- staff_user.id ที่เปิดโต๊ะ

-- อุปกรณ์ของลูกค้า: token แบบสุ่มเก็บเฉพาะ hash เพิกถอนได้ทันที (revoked_at)
create table guest_device (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  bill_id       uuid not null,
  table_id      uuid not null,
  token_hash    text not null unique,
  joined_via    text not null check (joined_via in ('pin', 'qr', 'invite')),
  created_at    timestamptz not null default now(),
  last_order_at timestamptz,
  revoked_at    timestamptz,
  unique (id, tenant_id),
  foreign key (bill_id, tenant_id) references bill (id, tenant_id),
  foreign key (table_id, tenant_id) references dining_table (id, tenant_id)
);
create index guest_device_active on guest_device (bill_id) where revoked_at is null;

-- QR ชวนเพื่อนร่วมโต๊ะ (อายุสั้น เก็บเฉพาะ hash ของโค้ด)
create table guest_session_invites (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  bill_id           uuid not null,
  created_by_device uuid not null references guest_device(id),
  code_hash         text not null unique,
  expires_at        timestamptz not null,
  uses              int not null default 0,
  max_uses          int not null default 8,
  created_at        timestamptz not null default now(),
  foreign key (bill_id, tenant_id) references bill (id, tenant_id)
);
create index guest_invites_bill on guest_session_invites (bill_id);

do $$
declare t text;
begin
  foreach t in array array['guest_device', 'guest_session_invites'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = nullif(current_setting(''app.tenant'', true), '''')::uuid)
         with check (tenant_id = nullif(current_setting(''app.tenant'', true), '''')::uuid)', t);
  end loop;
end $$;

grant select, insert, update on guest_device, guest_session_invites to pos_app;
grant update (last_reset_on) on tenant to pos_app;   -- worker จองรอบ reset ของวัน
