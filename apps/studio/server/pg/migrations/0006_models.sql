-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0006_models — data/models.json
CREATE TABLE studio.model_link (
  org_id        uuid NOT NULL REFERENCES studio.org,
  record_key    text NOT NULL CHECK (record_key ~ '^(connectors|components|wires|pcbas|bodies|interfaces|mechanicals|kits)/[a-z0-9][a-z0-9._-]*$'),
  body          json NOT NULL,                  -- ModelLink, JSON.stringify
  doc           jsonb GENERATED ALWAYS AS (body::jsonb) STORED,
  etag          text GENERATED ALWAYS AS (studio.content_etag(body::text)) STORED,   -- = linkETag(link), the If-Match the Library holds
  source_kind   text GENERATED ALWAYS AS (body::jsonb ->> 'sourceKind') STORED,
  asset_key     text GENERATED ALWAYS AS (body::jsonb ->> 'asset') STORED,          -- sha256 (upload) or sourceKey (import)
  imported      boolean GENERATED ALWAYS AS ((body::jsonb -> 'files') IS NOT NULL) STORED,
  entity_id     uuid,                           -- the Library record; a ref edge by another name
  row_version   bigint NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES studio.person,
  PRIMARY KEY (org_id, record_key),
  CHECK (body::jsonb ->> 'record' = record_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES studio.entity (org_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX model_link_asset ON studio.model_link (asset_key);
CREATE TRIGGER model_link_touch BEFORE UPDATE ON studio.model_link FOR EACH ROW EXECUTE FUNCTION studio.touch_row();
CREATE TRIGGER model_link_audit AFTER INSERT OR UPDATE OR DELETE ON studio.model_link FOR EACH ROW EXECUTE FUNCTION studio.audit_row();
