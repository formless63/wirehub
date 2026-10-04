-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0009_jobs
CREATE TABLE studio.job_run (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL REFERENCES studio.org,
  kind         text NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9:-]*$'),   -- 'import', 'model-cache', 'derive', 'blob-gc', 'backup',
                                                                       -- 'restore-check', 'parity', or '<module>:<queue>'
  boss_id      uuid,                          -- pg-boss job id
  status       text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  request      jsonb NOT NULL DEFAULT '{}',
  steps        jsonb NOT NULL DEFAULT '[]',   -- step reports as the job streams them
  result       jsonb,                         -- a plan summary; its files are job_file rows
  error        text,
  requested_by uuid REFERENCES studio.person,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  change_set_id bigint REFERENCES studio.change_set  -- publish: the set it committed
);
CREATE INDEX job_run_recent ON studio.job_run (org_id, kind, created_at DESC);

-- an import's plan: every file with its new text and what it replaces
CREATE TABLE studio.job_file (
  job_id       uuid NOT NULL REFERENCES studio.job_run ON DELETE CASCADE,
  path         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('new', 'changed', 'unchanged')),
  before_etag  text,
  content      text,                          -- text files
  sha256       text,                          -- binary files → blob
  PRIMARY KEY (job_id, path),
  CHECK ((content IS NULL) <> (sha256 IS NULL))
);

-- parity reports (migration from files only)
CREATE TABLE studio.parity_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES studio.org,
  file_rev    text NOT NULL,                  -- the file catalog compared (git HEAD or a digest)
  pg_version  bigint NOT NULL,
  endpoints   integer NOT NULL,
  diffs       integer NOT NULL,
  report      jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
