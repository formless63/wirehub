-- Generated from specs/postgres-backend.md §3 (rev 6.13). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0026_tool_runs — native tool-pack runs and their outputs (docs/jobs-and-tool-packs.md)
-- One row per op a tool pack ran for a record: the exact source inputs (path + sha256), the
-- pack, its image id and the tool's own version, the parameters, the findings and the log.
-- Its outputs are derived blobs (rebuildable from the pinned pack and the source), kept while
-- a run names them. Not catalog state: no change set, export, audit trigger or git mirror.
-- job_id has no foreign key: a finished job_run row is swept long before its outputs are.
CREATE TABLE studio.tool_run (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL REFERENCES studio.org,
  job_id       uuid,
  record       text NOT NULL CHECK (record ~ '^[a-z]+/[a-z0-9][a-z0-9._-]*$'),
  identity     jsonb NOT NULL DEFAULT '{}',   -- the record's revision/build when the run was asked for
  sources      jsonb NOT NULL,                -- [{ role, path, sha256 }]
  pack         text NOT NULL CHECK (pack ~ '^[a-z0-9][a-z0-9-]*$'),
  pack_version text NOT NULL,
  image        text NOT NULL,
  image_id     text NOT NULL,
  tool         jsonb NOT NULL,                -- { name, version } as the pack reported it
  op           text NOT NULL CHECK (op ~ '^[a-z0-9][a-z0-9-]*$'),
  params       jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL CHECK (status IN ('ok', 'failed')),
  findings     jsonb NOT NULL DEFAULT '[]',
  log          text CHECK (length(log) <= 200000),
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_run_record ON studio.tool_run (org_id, record, created_at DESC);
CREATE TABLE studio.tool_output (
  org_id     uuid NOT NULL REFERENCES studio.org,
  run_id     uuid NOT NULL REFERENCES studio.tool_run ON DELETE CASCADE,
  path       text NOT NULL,
  role       text NOT NULL,
  media_type text NOT NULL,
  size       bigint NOT NULL CHECK (size >= 0),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, path),
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
CREATE INDEX tool_output_blob ON studio.tool_output (org_id, sha256);
ALTER TABLE studio.tool_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.tool_run FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.tool_run USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
ALTER TABLE studio.tool_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.tool_output FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.tool_output USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.tool_run, studio.tool_output TO studio_app;
GRANT SELECT ON studio.tool_run, studio.tool_output TO studio_ro;
