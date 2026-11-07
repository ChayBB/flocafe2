# Test-only database bootstrap for pos-server (mirrors deploy/db-setup.sql with fixed passwords).
# Mounted into the Postgres image as an init script; never use these credentials outside tests.
\set ON_ERROR_STOP on

create role pos_migrate login password 'mig_pw';
create role pos_app login password 'app_pw';

create database pos owner pos_migrate;

revoke all on database pos from public;
grant connect on database pos to pos_app;

alter role pos_app set statement_timeout = '10s';
alter role pos_app set idle_in_transaction_session_timeout = '15s';
alter role pos_app set lock_timeout = '5s';

\connect pos

revoke all on schema public from public;
grant usage on schema public to pos_app;
