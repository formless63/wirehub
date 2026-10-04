-- Generated from specs/postgres-backend.md §3 (rev 6.2). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0008_derived_blobs — the converted-model cache, as blobs
CREATE TABLE studio.derived_blob (
  org_id           uuid NOT NULL REFERENCES studio.org,
  cache            text NOT NULL CHECK (cache ~ '^[a-z0-9-]+$'),   -- 'model'; modules may add caches
  key              text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  part             text NOT NULL DEFAULT '',
  sha256           text NOT NULL,
  builder_version  text NOT NULL,                                  -- CONVERTER_VERSION
  inputs           jsonb NOT NULL,                                 -- what it was built from: [{kind, ref, sha256}]
  triangles        integer,
  job_id           uuid,
  built_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, cache, key, part),
  FOREIGN KEY (org_id, sha256) REFERENCES studio.blob (org_id, sha256) ON DELETE RESTRICT
);
