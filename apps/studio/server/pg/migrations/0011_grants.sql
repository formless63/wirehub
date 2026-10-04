-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0011_grants
GRANT USAGE ON SCHEMA studio TO studio_app, studio_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA studio TO studio_app;
REVOKE INSERT, UPDATE, DELETE ON studio.audit_log FROM studio_app;
REVOKE UPDATE, DELETE ON studio.change, studio.change_set FROM studio_app;
GRANT SELECT ON ALL TABLES IN SCHEMA studio TO studio_ro;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA studio TO studio_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA studio TO studio_app, studio_ro;
-- the migrator's own table (schema wirehub_migrations, §6): the studio reads it
-- at boot and refuses to serve while a migration is pending
GRANT USAGE ON SCHEMA wirehub_migrations TO studio_app, studio_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA wirehub_migrations TO studio_app, studio_ro;
