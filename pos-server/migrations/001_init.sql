-- POS-Server: QR ordering core
-- รันด้วย role pos_migrate (เจ้าของตาราง) — pos_app ไม่ใช่เจ้าของ จึงถูก RLS บังคับ

create table tenant (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name       text not null,
  active     boolean not null default true,
  -- require_confirm: พนักงานต้องกดยืนยันก่อนส่งเข้าครัว (กัน QR ที่ถูกถ่ายรูปไปสั่งจากที่อื่น)
  settings   jsonb not null default '{"require_confirm": false}',
  created_at timestamptz not null default now()
);

create table dining_table (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id),
  label      text not null,
  qr_version int  not null default 1,   -- เพิ่มค่าเพื่อ rotate QR + ทำให้ session เดิมใช้ไม่ได้
  active     boolean not null default true,
  unique (tenant_id, label),
  unique (id, tenant_id)
);

create table bill (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  table_id  uuid not null,
  status    text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, tenant_id),
  foreign key (table_id, tenant_id) references dining_table (id, tenant_id)
);
-- หนึ่งบิลเปิดต่อโต๊ะ: สั่งพร้อมกันก็สร้างบิลซ้ำไม่ได้
create unique index one_open_bill on bill (table_id) where status = 'open';

create table menu_item (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  name        text not null,
  description text,
  category    text,
  price_satang int not null check (price_satang >= 0 and price_satang < 100000000),
  available   boolean not null default true,
  sort        int not null default 0,
  image_url   text,
  unique (id, tenant_id)
);
create index menu_item_tenant on menu_item (tenant_id, sort);

create table orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  bill_id         uuid not null,
  status          text not null default 'accepted'
                  check (status in ('pending_confirm', 'accepted', 'preparing', 'ready', 'served', 'cancelled')),
  idempotency_key text not null check (length(idempotency_key) between 16 and 64),
  request_hash    text not null,
  total_satang    int  not null check (total_satang >= 0),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (id, tenant_id),
  foreign key (bill_id, tenant_id) references bill (id, tenant_id)
);
create index orders_bill on orders (bill_id);
create index orders_active on orders (tenant_id, created_at)
  where status in ('pending_confirm', 'accepted', 'preparing', 'ready');

create table order_item (
  id            bigserial primary key,
  tenant_id     uuid not null,
  order_id      uuid not null,
  menu_item_id  uuid not null,
  name_snapshot text not null,
  unit_satang   int  not null,
  qty           int  not null check (qty between 1 and 20),
  note          text,
  foreign key (order_id, tenant_id) references orders (id, tenant_id),
  foreign key (menu_item_id, tenant_id) references menu_item (id, tenant_id)
);
create index order_item_order on order_item (order_id);

create table staff_user (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id),
  name       text not null,
  role       text not null check (role in ('kitchen', 'cashier', 'manager')),
  token_hash text not null unique,      -- sha256(token) เก็บเฉพาะ hash
  active     boolean not null default true
);

-- outbox: ไม่มี RLS (worker อ่านข้ามร้าน) เก็บแค่ id อ้างอิง ไม่เก็บข้อมูลลูกค้า
create table outbox (
  id              bigserial primary key,
  tenant_id       uuid not null,
  topic           text not null,
  payload         jsonb not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz
);
create index outbox_pending on outbox (next_attempt_at) where processed_at is null;

-- rate limit ที่ใช้ร่วมกันระหว่าง process (UNLOGGED = เร็ว ไม่ต้องกู้หลัง crash)
create unlogged table rate_limit (
  key          text not null,
  window_start timestamptz not null,
  n            int not null default 0,
  primary key (key, window_start)
);

-- RLS: ทุกตารางที่มี tenant_id (ยกเว้น outbox/tenant)
do $$
declare t text;
begin
  foreach t in array array['dining_table', 'bill', 'menu_item', 'orders', 'order_item', 'staff_user'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = nullif(current_setting(''app.tenant'', true), '''')::uuid)
         with check (tenant_id = nullif(current_setting(''app.tenant'', true), '''')::uuid)', t);
  end loop;
end $$;

-- สิทธิ์ขั้นต่ำของ pos_app (ไม่มี delete บนข้อมูลธุรกิจ)
grant select on tenant to pos_app;
grant select, insert, update on dining_table, bill, menu_item, orders, staff_user to pos_app;
grant select, insert on order_item to pos_app;
grant select, insert, update on outbox to pos_app;
grant select, insert, update, delete on rate_limit to pos_app;
grant usage, select on all sequences in schema public to pos_app;
