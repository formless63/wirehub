-- Generated from specs/postgres-backend.md §3 and docs/inventory.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0033_inventory_volume — lots counted by volume (resin, in ml), beside count, length and mass.
ALTER TABLE studio.inv_lot DROP CONSTRAINT inv_lot_dim_check;
ALTER TABLE studio.inv_lot ADD CONSTRAINT inv_lot_dim_check CHECK (dim IN ('count', 'length', 'mass', 'volume'));
