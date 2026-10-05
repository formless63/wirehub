-- Generated from specs/postgres-backend.md §3 (rev 6.10). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0022_model_link_part_number_keys — a revision's model link keyed by a part number (cs-9ar)
-- `revisions/<part>/<revision>`: `<part>` is a Library record id or a part number
-- (`ABC-123456-00`), so it takes upper-case letters too (0021 allowed lower case only).
ALTER TABLE studio.model_link DROP CONSTRAINT model_link_record_key_check;
ALTER TABLE studio.model_link ADD CONSTRAINT model_link_record_key_check CHECK (
  record_key ~ '^(connectors|components|wires|pcbas|bodies|interfaces|mechanicals|kits)/[a-z0-9][a-z0-9._-]*$'
  OR record_key ~ '^revisions/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$');
