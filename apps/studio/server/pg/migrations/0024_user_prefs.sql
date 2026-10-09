-- Generated from specs/postgres-backend.md §3 (rev 6.13). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0024_user_prefs — per-person UI preferences (cs-74m4)
-- One row per person: the preferences the browser shows (module slot pins, theme, table
-- column choices) as one JSON object. Not a catalog table: no change set, export or git
-- mirror reads it, and it has no audit trigger. `user_key` is `email:<address>` for a
-- signed-in person, `local:<name>` when there is no login.
CREATE TABLE studio.user_pref (
  org_id      uuid NOT NULL REFERENCES studio.org,
  user_key    text NOT NULL CHECK (length(user_key) BETWEEN 1 AND 320),
  prefs       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(prefs) = 'object' AND pg_column_size(prefs) <= 65536),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_key)
);
ALTER TABLE studio.user_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.user_pref FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.user_pref USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.user_pref TO studio_app;
GRANT SELECT ON studio.user_pref TO studio_ro;
