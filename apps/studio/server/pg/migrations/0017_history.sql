-- Generated from specs/postgres-backend.md §3 (rev 6.6). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0017_history — change history: each change's earlier state (§3.5; cs-5k1.4)
-- The state of the record before the change, as the commit read it before
-- applying the set: what a history diff and a restore compare against.
-- JSON null = there was no such record; SQL NULL = not recorded (rows written
-- before this migration, binary records, moves, and the second and later
-- changes of one record within a set).
ALTER TABLE studio.change ADD COLUMN before_body json;

-- A record's history: its changes by kind and key, in order.
CREATE INDEX change_kind_key ON studio.change (kind, key, change_set_id);
-- The hub-wide history, filtered by date.
CREATE INDEX change_set_created ON studio.change_set (org_id, created_at);
