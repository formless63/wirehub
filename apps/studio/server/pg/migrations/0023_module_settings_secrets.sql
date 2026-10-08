-- Generated from specs/postgres-backend.md §3 (rev 6.12). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0023_module_settings_secrets — secrets runtime modules declare (module API 1.5, cs-nws)
-- A module's declared secret (a supplier's API key …) is a row of studio.settings_secret like
-- every other Settings secret, named module.<module id>.<key>: same AES-256-GCM ciphertext under
-- WIREHUB_SETTINGS_KEY, same org-scoped RLS, rotated with the rest. The name check admits that
-- three-part form (a module id is kebab-case). No new table, policy or trigger.
ALTER TABLE studio.settings_secret DROP CONSTRAINT settings_secret_name_check;
ALTER TABLE studio.settings_secret ADD CONSTRAINT settings_secret_name_check CHECK (
  name ~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'
  OR name ~ '^module\.[a-z0-9]+(-[a-z0-9]+)*\.[a-z][A-Za-z0-9]*$');
