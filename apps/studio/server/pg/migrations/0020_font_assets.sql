-- Generated from specs/postgres-backend.md §3 (rev 6.9). Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0020_font_assets — fonts in the blob and asset tables (docs/modules.md "The hub's own identity")
-- A hub may set its documents in a licensed typeface: Settings, Branding stores the uploaded
-- TrueType, OpenType or WOFF2 file as an asset (data/assets/<sha256>.ttf|otf|woff2), and a data
-- pack may ship fonts under fonts/. Both are blobs: the two allowed-type lists gain the font types.
-- Nothing else changes: no table, no policy, no trigger.
ALTER TABLE studio.blob DROP CONSTRAINT blob_media_type_check;
ALTER TABLE studio.blob ADD CONSTRAINT blob_media_type_check CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf',
                                                   'application/zip', 'model/gltf-binary', 'model/stl', 'font/ttf', 'font/otf', 'font/woff2', 'application/octet-stream'));
ALTER TABLE studio.asset DROP CONSTRAINT asset_mime_check;
ALTER TABLE studio.asset ADD CONSTRAINT asset_mime_check CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf', 'model/gltf-binary', 'model/stl', 'font/ttf', 'font/otf', 'font/woff2'));
