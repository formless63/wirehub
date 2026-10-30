-- Generated from specs/postgres-backend.md §3 and specs/knowledge.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0027_attachment_assets — notes and projects attach files (specs/knowledge.md)
-- A note's attachment is a shared asset like a drawing photo: photos (PNG, JPEG), PDFs and, new
-- here, any other file — a ZIP archive or opaque bytes (application/octet-stream), which the hub
-- only ever serves as a download. The blob list already allows both types; the asset list gains them.
-- Nothing else changes: no table, no policy, no trigger. The notes themselves are catalog
-- documents (data/knowledge/…) in studio.catalog_doc.
ALTER TABLE studio.asset DROP CONSTRAINT asset_mime_check;
ALTER TABLE studio.asset ADD CONSTRAINT asset_mime_check CHECK (mime IN ('image/png', 'image/jpeg', 'application/pdf', 'model/gltf-binary', 'model/stl', 'font/ttf', 'font/otf', 'font/woff2', 'application/zip', 'application/octet-stream'));
