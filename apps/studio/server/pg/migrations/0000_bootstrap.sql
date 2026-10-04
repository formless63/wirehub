-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0000_bootstrap — extensions, schemas, helpers
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS studio;
CREATE SCHEMA IF NOT EXISTS auth;

-- The org a connection acts for. Set per transaction by PgStore:
--   SELECT set_config('studio.org_id', $1, true)
-- Unset → NULL → RLS lets nothing through (fail closed).
CREATE FUNCTION studio.current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('studio.org_id', true), '')::uuid $$;

-- The change set a transaction is writing (set by PgStore after it inserts the change_set row).
CREATE FUNCTION studio.current_change_set() RETURNS bigint
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('studio.change_set_id', true), '')::bigint $$;

-- A content ETag, byte-identical to apps/studio/server/etag.ts contentETag():
-- '"' + sha256(JSON.stringify(value)).hex.slice(0, 32) + '"'.
-- Valid only because `body` holds exactly JSON.stringify(value) (§3.1).
CREATE FUNCTION studio.content_etag(body text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT '"' || left(encode(sha256(convert_to(body, 'UTF8')), 'hex'), 32) || '"' $$;

-- row_version + updated_at on every UPDATE of a versioned table
CREATE FUNCTION studio.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;   -- PgStore never issues a no-op UPDATE (WHERE body IS DISTINCT FROM …)
  NEW.updated_at := now();
  RETURN NEW;
END $$;
