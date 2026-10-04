-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0002_audit
CREATE TABLE studio.change_set (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES studio.org,
  catalog_version  bigint NOT NULL,           -- the version this set produced
  actor_id         uuid REFERENCES studio.person,
  actor_label      text NOT NULL,             -- the person's name, or 'WireHub (local)'
  source           text NOT NULL CHECK (source IN ('studio', 'worker', 'import', 'git-history', 'migration', 'script')),
  api_token_id     uuid,                      -- the personal API token the request came with (auth.api_token.id), for audit and
                                              -- revocation only; NULL for a session. The actor is the token's person.
  method           text,
  path             text,
  message          text NOT NULL,             -- backup/commit-message.ts commitMessage(), unchanged
  git_commit       text CHECK (git_commit ~ '^[0-9a-f]{40}$'),  -- git-history import and shadow sync only
  job_id           uuid,                      -- worker sets: the job_run that published it
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, catalog_version)
);

CREATE TABLE studio.change (
  change_set_id  bigint NOT NULL REFERENCES studio.change_set ON DELETE RESTRICT,
  seq            integer NOT NULL CHECK (seq >= 0),
  kind           text NOT NULL,               -- RecordKind (§3.3), or 'doc' / 'derived' / 'blob'
  key            text NOT NULL,
  op             text NOT NULL CHECK (op IN ('put', 'delete', 'move')),
  to_key         text,
  before_etag    text,
  after_etag     text,
  after_body     json,                        -- put: the document as written (NULL for blobs)
  PRIMARY KEY (change_set_id, seq),
  CHECK ((op = 'move') = (to_key IS NOT NULL))
);

-- Backstop: every row-level write to a catalog table lands here, with the
-- change set the writer declared — or NULL, which a daily check treats as an
-- alarm (§8.6): a write that bypassed PgStore.
CREATE TABLE studio.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid,
  table_name     text NOT NULL,
  row_key        text NOT NULL,
  op             text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  change_set_id  bigint,
  db_user        text NOT NULL DEFAULT current_user,
  txid           xid8 NOT NULL DEFAULT pg_current_xact_id(),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_unattributed ON studio.audit_log (at) WHERE change_set_id IS NULL;

CREATE FUNCTION studio.audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = studio, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  INSERT INTO studio.audit_log (org_id, table_name, row_key, op, change_set_id)
  VALUES ((r ->> 'org_id')::uuid, TG_TABLE_NAME,
          coalesce(r ->> 'id', r ->> 'path', r ->> 'record_key', r ->> 'sha256', '?'),
          TG_OP, studio.current_change_set());
  RETURN NULL;
END $$;
