-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0015_self_hosted — first-run setup, revoking access, backups through studio_ro
-- How many orgs exist (org is under RLS): zero means first-run setup (§9.1).
CREATE FUNCTION studio.org_count() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = studio, pg_temp
  AS $$ SELECT count(*)::integer FROM studio.org $$;
GRANT EXECUTE ON FUNCTION studio.org_count() TO studio_app, studio_ro;

-- An owner revokes a person's access without losing who made which change.
ALTER TABLE studio.person ADD COLUMN disabled_at timestamptz;

-- pg_dump as studio_ro (BYPASSRLS, read-only): every table and sequence it dumps.
GRANT USAGE ON SCHEMA auth TO studio_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO studio_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA studio, auth TO studio_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE studio_owner IN SCHEMA studio, auth GRANT SELECT ON TABLES TO studio_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE studio_owner IN SCHEMA studio, auth GRANT SELECT ON SEQUENCES TO studio_ro;
