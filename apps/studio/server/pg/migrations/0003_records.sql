-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0003_records
-- The stable identity of a named thing (uuidv7), and its slug (the natural
-- id the pure model and every URL use). A rename is an UPDATE of `slug`.
CREATE TABLE studio.entity (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES studio.org,
  kind        text NOT NULL CHECK (kind IN (
                'design', 'connector', 'component', 'wire', 'pcba', 'body', 'interface',
                'mechanical', 'kit', 'wire-part', 'wire-recipe', 'vocab', 'build', 'depiction')),
  slug        text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, slug),
  UNIQUE (org_id, id)
);
CREATE INDEX entity_slug_trgm ON studio.entity USING gin (slug gin_trgm_ops);

-- A document of an entity. Most entities have one record (collection '');
-- a design has its drawing sheet as collection 'drawing'.
CREATE TABLE studio.record (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id       uuid NOT NULL,
  entity_id    uuid NOT NULL,
  collection   text NOT NULL DEFAULT '' CHECK (collection ~ '^[a-z0-9-]*$'),
  ord          integer NOT NULL DEFAULT 0,     -- position in its list file (file order is data)
  body         json NOT NULL,                  -- exactly JSON.stringify(value): key order preserved (§3.1)
  doc          jsonb GENERATED ALWAYS AS (body::jsonb) STORED,
  etag         text GENERATED ALWAYS AS (studio.content_etag(body::text)) STORED,
  label        text GENERATED ALWAYS AS (body::jsonb ->> 'label') STORED,
  row_version  bigint NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES studio.person,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES studio.person,
  FOREIGN KEY (org_id, entity_id) REFERENCES studio.entity (org_id, id) ON DELETE CASCADE,
  UNIQUE (entity_id, collection),
  UNIQUE (org_id, id)
);
CREATE INDEX record_doc_gin ON studio.record USING gin (doc jsonb_path_ops);
CREATE INDEX record_label_trgm ON studio.record USING gin (label gin_trgm_ops);
CREATE INDEX record_list ON studio.record (org_id, collection, ord);
CREATE TRIGGER record_touch BEFORE UPDATE ON studio.record FOR EACH ROW EXECUTE FUNCTION studio.touch_row();
CREATE TRIGGER record_audit AFTER INSERT OR UPDATE OR DELETE ON studio.record FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- Reference edges, rebuilt for a record whenever its body changes. Deleting an
-- entity something still references fails at COMMIT (deferred) → 409 "still used by …".
CREATE TABLE studio.ref_edge (
  org_id      uuid NOT NULL,
  from_record uuid NOT NULL,
  to_entity   uuid NOT NULL,
  role        text NOT NULL,                  -- 'connector' | 'pcba' | 'wire' | 'body' | 'interface' | 'kit-part' | …
  PRIMARY KEY (from_record, to_entity, role),
  FOREIGN KEY (org_id, from_record) REFERENCES studio.record (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, to_entity) REFERENCES studio.entity (org_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ref_edge_to ON studio.ref_edge (to_entity);
-- references the model names but the catalog does not have (a retired board a design still cites)
CREATE TABLE studio.ref_dangling (
  org_id      uuid NOT NULL,
  from_record uuid NOT NULL,
  to_kind     text NOT NULL,
  to_slug     text NOT NULL,
  role        text NOT NULL,
  PRIMARY KEY (from_record, to_kind, to_slug, role),
  FOREIGN KEY (org_id, from_record) REFERENCES studio.record (org_id, id) ON DELETE CASCADE
);

-- File-shaped documents the app reads whole (§3.2) and the envelopes of list files.
CREATE TABLE studio.catalog_doc (
  org_id           uuid NOT NULL REFERENCES studio.org,
  path             text NOT NULL CHECK (path ~ '^(data|depictions)/[A-Za-z0-9._/-]+$' AND path !~ '\.\.'),
  media_type       text NOT NULL CHECK (media_type IN ('application/json', 'text/markdown', 'text/plain')),
  body             text NOT NULL,             -- JSON: JSON.stringify(value); markdown and plain text: the exact text
  etag             text GENERATED ALWAYS AS (studio.content_etag(body)) STORED,
  list_kind        text,                      -- envelope: whose records fill it
  list_collection  text,
  list_member      text,                      -- '' = the file is the array itself
  row_version      bigint NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES studio.person,
  PRIMARY KEY (org_id, path),
  CHECK ((list_kind IS NULL) = (list_member IS NULL))
);
CREATE TRIGGER catalog_doc_touch BEFORE UPDATE ON studio.catalog_doc FOR EACH ROW EXECUTE FUNCTION studio.touch_row();
CREATE TRIGGER catalog_doc_audit AFTER INSERT OR UPDATE OR DELETE ON studio.catalog_doc FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- Derived documents (tags/*, and a module's derived files). Only the commit (or the derive job) writes them.
CREATE TABLE studio.derived_doc (
  org_id          uuid NOT NULL REFERENCES studio.org,
  path            text NOT NULL,
  derived_kind    text NOT NULL CHECK (derived_kind IN ('tags', 'module')),
  module_id       text,                       -- derived_kind 'module': which module
  media_type      text NOT NULL CHECK (media_type IN ('application/json', 'text/markdown')),
  body            text NOT NULL,
  inputs_version  bigint NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, path),
  CHECK ((derived_kind = 'module') = (module_id IS NOT NULL))
);
