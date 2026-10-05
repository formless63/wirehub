-- Generated from specs/postgres-backend.md §3 (rev 6.7). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0018_version_approval — release approvals on saved versions (§3.2; cs-5k1.11)
-- A locked revision stays frozen, but an approval step may be recorded on it:
-- `approval` is set or replaced and exactly one `submit`, `approve` or
-- `reject` entry is appended to `history`; nothing else changes. (An edit
-- needs the unlock first, as before, and clears `approval`.)
CREATE OR REPLACE FUNCTION studio.guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := OLD.body::jsonb;
  n jsonb;
  kept jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked THEN RAISE EXCEPTION 'revision % of design % is locked and cannot be deleted', OLD.rev, OLD.design_id USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NOT OLD.locked THEN RETURN NEW; END IF;
  n := NEW.body::jsonb;
  IF NEW.rev <> OLD.rev OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'revision % is locked: rev and org are immutable', OLD.rev USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- (b) rename
  IF (n #- '{designId}' #- '{design,id}') = (o #- '{designId}' #- '{design,id}') THEN RETURN NEW; END IF;
  SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb) INTO kept
    FROM jsonb_array_elements(n -> 'history') WITH ORDINALITY AS t(e, i)
   WHERE i <= jsonb_array_length(o -> 'history');
  -- (a) unlock
  IF NEW.design_id = OLD.design_id
     AND (n -> 'unlocked') IS NOT NULL
     AND (n - 'unlocked' - 'history') = (o - 'history')
     AND kept = (o -> 'history')
     AND jsonb_array_length(n -> 'history') = jsonb_array_length(o -> 'history') + 1
     AND (n -> 'history' -> -1 ->> 'action') = 'unlock' THEN
    RETURN NEW;
  END IF;
  -- (c) an approval step: only `approval` and one appended history entry change
  IF NEW.design_id = OLD.design_id
     AND (n -> 'unlocked') IS NULL
     AND (n - 'approval' - 'history') = (o - 'approval' - 'history')
     AND (n -> 'approval') IS NOT NULL
     AND kept = (o -> 'history')
     AND jsonb_array_length(n -> 'history') = jsonb_array_length(o -> 'history') + 1
     AND (n -> 'history' -> -1 ->> 'action') IN ('submit', 'approve', 'reject') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'revision % of design % is locked: unlock it first', OLD.rev, OLD.design_id USING ERRCODE = 'integrity_constraint_violation';
END $$;
