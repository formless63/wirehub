-- Generated from specs/postgres-backend.md §3 and docs/inventory.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0034_unit_tests — test results recorded against built units (docs/inventory.md, Units and test results)
-- A built unit is one good unit of a design batch: `<batch id>.<n>`. A result (continuity or
-- bench, pass or fail) is written once and never changed; a re-test is a new row. `coverage` is
-- the fingerprint of what the test covered at the design state the unit was built to, so
-- staleness is worked out on read against the design's latest saved version.
CREATE TABLE studio.inv_unit_test (
  org_id      uuid NOT NULL REFERENCES studio.org,
  id          text NOT NULL CHECK (id ~ '^ut-[0-9a-f]{10}$'),
  unit_id     text NOT NULL CHECK (unit_id ~ '^bat-[0-9a-f]{10}\.[1-9][0-9]{0,4}$'),
  design_id   text NOT NULL CHECK (length(design_id) BETWEEN 1 AND 200),
  kind        text NOT NULL CHECK (kind IN ('continuity', 'bench')),
  result      text NOT NULL CHECK (result IN ('pass', 'fail')),
  note        text CHECK (length(note) <= 2000),
  coverage    jsonb CHECK (coverage IS NULL OR jsonb_typeof(coverage) = 'object'),
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL CHECK (length(actor) <= 320),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX inv_unit_test_unit ON studio.inv_unit_test (org_id, unit_id, at);
CREATE INDEX inv_unit_test_design ON studio.inv_unit_test (org_id, design_id, at);

ALTER TABLE studio.inv_unit_test ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_unit_test FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_unit_test USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());

-- written once, like the ledger
GRANT SELECT, INSERT ON studio.inv_unit_test TO studio_app;
GRANT SELECT ON studio.inv_unit_test TO studio_ro;
