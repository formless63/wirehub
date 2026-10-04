-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0005_blobs
CREATE TABLE studio.blob (
  org_id       uuid NOT NULL REFERENCES studio.org,
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size         bigint NOT NULL CHECK (size >= 0),
  media_type   text NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf',
                                                   'application/zip', 'model/gltf-binary', 'model/stl', 'application/octet-stream')),
  class        text NOT NULL DEFAULT 'record' CHECK (class IN ('record', 'derived')),  -- derived: rebuildable, skipped by the backup
  object_key   text NOT NULL,                 -- '<org>/sha256/<aa>/<bb>/<hex>'
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'stored', 'orphan')),
  backed_up_at timestamptz,                   -- record blobs: last seen in a completed backup (§8.4)
  created_at   timestamptz NOT NULL DEFAULT now(),
  orphaned_at  timestamptz,
  PRIMARY KEY (org_id, sha256),
  UNIQUE (object_key)
);
CREATE INDEX blob_gc ON studio.blob (orphaned_at) WHERE state = 'orphan';
CREATE INDEX blob_not_backed_up ON studio.blob (created_at) WHERE backed_up_at IS NULL AND state = 'stored' AND class = 'record';
CREATE TRIGGER blob_audit AFTER INSERT OR UPDATE OR DELETE ON studio.blob FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- The shared asset library (data/assets/index.json): photos, PDFs, uploaded 3D models.
CREATE TABLE studio.asset (
  org_id         uuid NOT NULL,
  sha256         text NOT NULL,
  mime           text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf', 'model/gltf-binary', 'model/stl')),
  original_name  text NOT NULL,
  src            text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES studio.person,
  PRIMARY KEY (org_id, sha256),
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
CREATE INDEX asset_name_trgm ON studio.asset USING gin (original_name gin_trgm_ops);

-- A drawing sheet's product photo (data/drawings/<id>.photo-ref.json). Keyed by
-- the design, not its drawing record: the file store keeps a photo without a
-- title block.
CREATE TABLE studio.drawing_photo (
  org_id        uuid NOT NULL,
  design_id     uuid NOT NULL,                -- entity of kind 'design'
  asset_sha256  text NOT NULL,
  PRIMARY KEY (design_id),
  FOREIGN KEY (org_id, design_id) REFERENCES studio.entity (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, asset_sha256) REFERENCES studio.asset (org_id, sha256) ON DELETE RESTRICT
);
CREATE TRIGGER drawing_photo_audit AFTER INSERT OR UPDATE OR DELETE ON studio.drawing_photo FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- depictions/<defId>/<file> — the artwork next to a depiction's meta.json record
-- (keyed by the depiction entity: a directory may hold files before its meta.json)
CREATE TABLE studio.depiction_file (
  org_id        uuid NOT NULL,
  depiction_id  uuid NOT NULL,                -- entity of kind 'depiction'
  name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]*\.(svg|png|jpg|jpeg|webp)$'),
  sha256        text NOT NULL,
  PRIMARY KEY (depiction_id, name),
  FOREIGN KEY (org_id, depiction_id) REFERENCES studio.entity (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
CREATE TRIGGER depiction_file_audit AFTER INSERT OR UPDATE OR DELETE ON studio.depiction_file FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- _versions/<id>/artwork/<sha>.<ext> — the artwork a design's revisions froze. The
-- file store keeps one content-addressed artwork store per design, shared by its
-- revisions (each revision's body names the blobs it uses), so the rows hang off
-- the design, not a revision. Content-addressed rows are immutable: never updated.
CREATE TABLE studio.design_artwork (
  org_id       uuid NOT NULL,
  design_id    uuid NOT NULL,                 -- entity of kind 'design'
  blob_name    text NOT NULL CHECK (blob_name ~ '^[0-9a-f]{64}\.[a-z0-9]{1,8}$'),
  sha256       text NOT NULL,
  PRIMARY KEY (design_id, blob_name),
  CHECK (left(blob_name, 64) = sha256),
  FOREIGN KEY (org_id, design_id) REFERENCES studio.entity (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
CREATE TRIGGER design_artwork_audit AFTER INSERT OR UPDATE OR DELETE ON studio.design_artwork FOR EACH ROW EXECUTE FUNCTION studio.audit_row();

-- Any other binary file under data/ or depictions/ the codec has no table for
-- (a legacy drawings/<id>.photo.<ext>, a module's binary file): path → blob.
CREATE TABLE studio.catalog_file (
  org_id      uuid NOT NULL REFERENCES studio.org,
  path        text NOT NULL CHECK (path ~ '^(data|depictions)/[A-Za-z0-9._/-]+$' AND path !~ '\.\.'),
  sha256      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, path),
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
CREATE TRIGGER catalog_file_audit AFTER INSERT OR UPDATE OR DELETE ON studio.catalog_file FOR EACH ROW EXECUTE FUNCTION studio.audit_row();
