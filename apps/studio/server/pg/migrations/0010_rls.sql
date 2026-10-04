-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0010_rls
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_head', 'person', 'change_set', 'entity', 'record', 'ref_edge', 'ref_dangling',
                           'catalog_doc', 'derived_doc', 'design_revision', 'design_working', 'design_draft',
                           'blob', 'asset', 'drawing_photo', 'depiction_file', 'design_artwork', 'catalog_file',
                           'model_link', 'edit_lock', 'edit_lock_displaced', 'derived_blob', 'job_run', 'parity_run'] LOOP
    EXECUTE format('ALTER TABLE studio.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE studio.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON studio.%I USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org())', t);
  END LOOP;
END $$;
-- the SECURITY DEFINER lookups run as the owner, whom FORCE subjects to RLS too:
-- studio.head_version() reads the head row of the org it is given
CREATE POLICY definer_read ON studio.catalog_head FOR SELECT TO studio_owner USING (true);
-- change / job_file inherit their parent's org through the FK
ALTER TABLE studio.change ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.change FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.change
  USING (EXISTS (SELECT 1 FROM studio.change_set s WHERE s.id = change_set_id))
  WITH CHECK (EXISTS (SELECT 1 FROM studio.change_set s WHERE s.id = change_set_id));
ALTER TABLE studio.job_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.job_file FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.job_file
  USING (EXISTS (SELECT 1 FROM studio.job_run j WHERE j.id = job_id))
  WITH CHECK (EXISTS (SELECT 1 FROM studio.job_run j WHERE j.id = job_id));
-- org: a session sees its own org row only
ALTER TABLE studio.org ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_self ON studio.org USING (id = studio.current_org());
-- audit_log: written by the SECURITY DEFINER trigger; the app may read its org's rows, never write
ALTER TABLE studio.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_read ON studio.audit_log FOR SELECT USING (org_id = studio.current_org());
