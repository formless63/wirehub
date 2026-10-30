-- Generated from specs/postgres-backend.md §3 (rev 6.9). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0031_3mf_assets — 3MF files in the blob and asset tables (WF-PRINT)
-- A print file uploaded for slicing may be a 3MF (data/assets/<sha256>.3mf): the two allowed-type
-- lists gain model/3mf. Nothing else changes.
ALTER TABLE studio.blob DROP CONSTRAINT blob_media_type_check;
ALTER TABLE studio.blob ADD CONSTRAINT blob_media_type_check CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf',
                                                   'application/zip', 'model/gltf-binary', 'model/stl', 'model/step', 'model/3mf', 'font/ttf', 'font/otf', 'font/woff2', 'application/octet-stream'));
ALTER TABLE studio.asset DROP CONSTRAINT asset_mime_check;
ALTER TABLE studio.asset ADD CONSTRAINT asset_mime_check CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf', 'model/gltf-binary', 'model/stl', 'model/step', 'model/3mf', 'font/ttf', 'font/otf', 'font/woff2', 'application/zip', 'application/octet-stream'));
