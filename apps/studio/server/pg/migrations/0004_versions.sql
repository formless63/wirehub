-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0004_versions
CREATE TABLE studio.design_revision (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL,
  design_id    uuid NOT NULL,                 -- entity of kind 'design'
  rev          integer NOT NULL CHECK (rev >= 0),
  body         json NOT NULL,                 -- DesignVersionFile, JSON.stringify
  doc          jsonb GENERATED ALWAYS AS (body::jsonb) STORED,
  etag         text GENERATED ALWAYS AS (studio.content_etag(body::text)) STORED,
  locked       boolean GENERATED ALWAYS AS ((body::jsonb -> 'unlocked') IS NULL) STORED,
  row_version  bigint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES studio.person,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES studio.person,
  FOREIGN KEY (org_id, design_id) REFERENCES studio.entity (org_id, id) ON DELETE RESTRICT,
  UNIQUE (design_id, rev),
  CHECK ((body::jsonb ->> 'rev')::int = rev)
);

-- A locked revision is frozen. Allowed on a locked row: (a) an unlock —
-- adds `unlocked`, appends to `history`, nothing else; (b) a design rename —
-- only `designId` / `design.id` (and `design_id`) change. Everything is
-- allowed while unlocked (edit, relock). Locked rows are never deleted.
CREATE FUNCTION studio.guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- (a) unlock
  SELECT coalesce(jsonb_agg(e ORDER BY i), '[]'::jsonb) INTO kept
    FROM jsonb_array_elements(n -> 'history') WITH ORDINALITY AS t(e, i)
   WHERE i <= jsonb_array_length(o -> 'history');
  IF NEW.design_id = OLD.design_id
     AND (n -> 'unlocked') IS NOT NULL
     AND (n - 'unlocked' - 'history') = (o - 'history')
     AND kept = (o -> 'history')
     AND jsonb_array_length(n -> 'history') = jsonb_array_length(o -> 'history') + 1
     AND (n -> 'history' -> -1 ->> 'action') = 'unlock' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'revision % of design % is locked: unlock it first', OLD.rev, OLD.design_id USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER design_revision_guard BEFORE UPDATE OR DELETE ON studio.design_revision FOR EACH ROW EXECUTE FUNCTION studio.guard_revision();
CREATE TRIGGER design_revision_touch BEFORE UPDATE ON studio.design_revision FOR EACH ROW EXECUTE FUNCTION studio.touch_row();
CREATE TRIGGER design_revision_audit AFTER INSERT OR UPDATE OR DELETE ON studio.design_revision FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

CREATE TABLE studio.design_working (
  org_id       uuid NOT NULL,
  design_id    uuid NOT NULL,
  body         json NOT NULL,                 -- WorkingState: {} or {basedOnRev}
  etag         text GENERATED ALWAYS AS (studio.content_etag(body::text)) STORED,
  row_version  bigint NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id),
  FOREIGN KEY (org_id, design_id) REFERENCES studio.entity (org_id, id) ON DELETE CASCADE
);
CREATE TRIGGER design_working_touch BEFORE UPDATE ON studio.design_working FOR EACH ROW EXECUTE FUNCTION studio.touch_row();

CREATE TABLE studio.design_draft (
  org_id       uuid NOT NULL,
  design_id    uuid NOT NULL,
  n            integer NOT NULL CHECK (n >= 1),
  body         json NOT NULL,                 -- DraftFile
  etag         text GENERATED ALWAYS AS (studio.content_etag(body::text)) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (design_id, n),
  FOREIGN KEY (org_id, design_id) REFERENCES studio.entity (org_id, id) ON DELETE CASCADE
);
