-- Generated from specs/postgres-backend.md §3 (rev 6.9). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0030_job_leases — a running job's lease, and the interrupted status (docs/jobs-and-tool-packs.md)
-- The process running a job renews lease_until every 30 s; the worker marks a running row whose
-- lease ran out (its process died) 'interrupted', so it no longer reads as running forever.
ALTER TABLE studio.job_run ADD COLUMN lease_until timestamptz;
ALTER TABLE studio.job_run DROP CONSTRAINT job_run_status_check;
ALTER TABLE studio.job_run ADD CONSTRAINT job_run_status_check CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'));
CREATE INDEX job_run_running ON studio.job_run (org_id, lease_until) WHERE status = 'running';
