-- Generated from specs/postgres-backend.md §3 (rev 6.8). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0019_settings_secrets — secrets entered in Settings, encrypted (specs/runtime-settings.md §4)
-- One row per secret an owner entered in Settings (the SMTP password, the OIDC
-- client secret, the alert webhook's URL and token, the git mirror's token and
-- key): AES-256-GCM ciphertext under the install's key (WIREHUB_SETTINGS_KEY),
-- never plain text. Not a catalog table: no change set, export or git mirror
-- reads it, and it has no audit trigger (the settings document records when a
-- secret was set, in the change history, and never what).
CREATE TABLE studio.settings_secret (
  org_id      uuid NOT NULL REFERENCES studio.org,
  name        text NOT NULL CHECK (name ~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'),
  ciphertext  text NOT NULL CHECK (ciphertext LIKE 'v1.%' AND length(ciphertext) <= 32768),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);
ALTER TABLE studio.settings_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.settings_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.settings_secret USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.settings_secret TO studio_app;
