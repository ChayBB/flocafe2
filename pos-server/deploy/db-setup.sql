-- รันครั้งเดียวด้วย superuser:
--   sudo -u postgres psql -v migrate_pw=<รหัสผ่าน> -v app_pw=<รหัสผ่าน> -f db-setup.sql
-- (ส่งรหัสผ่านเปล่า ๆ ไม่ต้องใส่เครื่องหมายคำพูด psql ใส่ให้เองผ่าน :'var')
-- (setup.sh สร้างรหัสผ่านสุ่มและส่งให้เอง)
\set ON_ERROR_STOP on

select format('create role pos_migrate login password %L', :'migrate_pw')
where not exists (select from pg_roles where rolname = 'pos_migrate') \gexec

select format('create role pos_app login password %L', :'app_pw')
where not exists (select from pg_roles where rolname = 'pos_app') \gexec

select 'create database pos owner pos_migrate'
where not exists (select from pg_database where datname = 'pos') \gexec

revoke all on database pos from public;
grant connect on database pos to pos_app;

-- pos_app ไม่ใช่ superuser/เจ้าของตาราง → RLS บังคับใช้จริง; ตัด query ที่ค้างนาน
alter role pos_app set statement_timeout = '10s';
alter role pos_app set idle_in_transaction_session_timeout = '15s';
alter role pos_app set lock_timeout = '5s';

\c pos
revoke all on schema public from public;
grant usage on schema public to pos_app;
