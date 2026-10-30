-- Generated from specs/postgres-backend.md §3 (rev 6.9). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0029_step_assets — STEP files in the blob and asset tables (WF-MECH)
-- A generated enclosure keeps its solids as STEP (data/assets/<sha256>.step) beside the STL and
-- GLB it already could: the two allowed-type lists gain model/step (the asset list keeps 0027's
-- application/zip and application/octet-stream). Nothing else changes.
ALTER TABLE studio.blob DROP CONSTRAINT blob_media_type_check;
ALTER TABLE studio.blob ADD CONSTRAINT blob_media_type_check CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf',
                                                   'application/zip', 'model/gltf-binary', 'model/stl', 'model/step', 'font/ttf', 'font/otf', 'font/woff2', 'application/octet-stream'));
ALTER TABLE studio.asset DROP CONSTRAINT asset_mime_check;
ALTER TABLE studio.asset ADD CONSTRAINT asset_mime_check CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf', 'model/gltf-binary', 'model/stl', 'model/step', 'font/ttf', 'font/otf', 'font/woff2', 'application/zip', 'application/octet-stream'));
