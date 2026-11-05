CREATE TABLE IF NOT EXISTS qr_stores (
  store_id text PRIMARY KEY,
  public_key text NOT NULL,
  device_name text NOT NULL,
  public_base_url text NOT NULL,
  public_host text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_pairings (
  id uuid PRIMARY KEY,
  code_hash char(64) NOT NULL UNIQUE,
  public_key text NOT NULL,
  device_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  store_id text REFERENCES qr_stores(store_id),
  public_base_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);

CREATE INDEX IF NOT EXISTS qr_pairings_pending_expiry_idx
  ON qr_pairings (expires_at) WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS api;
CREATE OR REPLACE VIEW api.store_status AS
  SELECT store_id, device_name, public_host, active, created_at, updated_at
  FROM public.qr_stores;

GRANT USAGE ON SCHEMA api TO web_anon;
GRANT SELECT ON api.store_status TO web_anon;
REVOKE ALL ON SCHEMA public FROM web_anon;
