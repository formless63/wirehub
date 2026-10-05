-- Generated from specs/postgres-backend.md §3 (rev 6.9). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0020_model_link_revision_keys — a revision's model link (cs-s97)
-- A link of `models.json` is keyed by its Library record (`<kind>/<id>`) or, for the
-- model of a part's revision no record shows (a WIP or superseded one),
-- `revisions/<part>/<revision>`. It names no entity, so `entity_id` stays null.
ALTER TABLE studio.model_link DROP CONSTRAINT model_link_record_key_check;
ALTER TABLE studio.model_link ADD CONSTRAINT model_link_record_key_check CHECK (
  record_key ~ '^(connectors|components|wires|pcbas|bodies|interfaces|mechanicals|kits)/[a-z0-9][a-z0-9._-]*$'
  OR record_key ~ '^revisions/[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$');
