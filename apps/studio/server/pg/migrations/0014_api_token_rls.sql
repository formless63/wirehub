-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0014_api_token_rls — the token table is org-scoped like every studio table
ALTER TABLE auth.api_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.api_token FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON auth.api_token USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
ALTER TABLE auth.invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON auth.invitation USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
