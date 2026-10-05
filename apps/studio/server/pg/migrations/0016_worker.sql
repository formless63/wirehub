-- Generated from specs/postgres-backend.md §3 (rev 6.5). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0016_worker — the worker's queue schema and its heartbeat (§2, §8.3)
-- pg-boss's schema: the worker and the studio (studio_app) create its tables
-- in it on first start; the app may not create schemas, so this one is made here.
CREATE SCHEMA pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO studio_app;
GRANT USAGE ON SCHEMA pgboss TO studio_ro;

-- One row per worker process, beaten every 60 s; a deep health check fails
-- when the newest is older than five minutes.
CREATE TABLE studio.worker_heartbeat (
  org_id      uuid NOT NULL REFERENCES studio.org,
  worker      text NOT NULL CHECK (length(worker) BETWEEN 1 AND 200),
  version     text NOT NULL,
  started_at  timestamptz NOT NULL,
  beat_at     timestamptz NOT NULL DEFAULT now(),
  queues      text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, worker)
);
ALTER TABLE studio.worker_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.worker_heartbeat FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.worker_heartbeat USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.worker_heartbeat TO studio_app;
