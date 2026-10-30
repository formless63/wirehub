-- Generated from specs/postgres-backend.md §3 and docs/inventory.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0032_inventory_batches — made units and print batches, lot detail edits (docs/inventory.md)
-- A batch records finished units of a design build (against its reservation) or a print of a
-- mechanical record (against a manufacturing variant): good and failed units, serials, a batch
-- code and what was measured. Like the ledger it is written once: the app may insert and read.
-- The ledger gains the batch a movement belongs to and an `edit` kind (a lot's code, supplier,
-- cost or note changed; quantity 0). A reservation counts the units finished against it.
ALTER TABLE studio.inv_movement DROP CONSTRAINT inv_movement_kind_check;
ALTER TABLE studio.inv_movement ADD CONSTRAINT inv_movement_kind_check CHECK (kind IN ('receive', 'move', 'split', 'adjust', 'consume', 'return', 'edit'));
ALTER TABLE studio.inv_movement ADD COLUMN batch_id text;
ALTER TABLE studio.inv_reservation ADD COLUMN units_done numeric NOT NULL DEFAULT 0 CHECK (units_done >= 0);

CREATE TABLE studio.inv_batch (
  org_id          uuid NOT NULL REFERENCES studio.org,
  id              text NOT NULL CHECK (id ~ '^bat-[0-9a-f]{10}$'),
  item_kind       text NOT NULL CHECK (item_kind IN ('connectors', 'wires', 'components', 'pcbas', 'mechanicals', 'designs')),
  item_id         text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  design_rev      integer,
  reservation_id  text,
  variant         text CHECK (length(variant) <= 64),
  units           numeric NOT NULL CHECK (units >= 0),
  failed          numeric NOT NULL DEFAULT 0 CHECK (failed >= 0),
  batch_code      text CHECK (length(batch_code) <= 120),
  serials         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(serials) <= 10000),
  measured        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(measured) = 'object'),
  output_lot      text,
  note            text CHECK (length(note) <= 2000),
  at              timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL CHECK (length(actor) <= 320),
  PRIMARY KEY (org_id, id),
  CHECK (units + failed > 0),
  FOREIGN KEY (org_id, reservation_id) REFERENCES studio.inv_reservation (org_id, id),
  FOREIGN KEY (org_id, output_lot) REFERENCES studio.inv_lot (org_id, id)
);
CREATE INDEX inv_batch_item ON studio.inv_batch (org_id, item_kind, item_id, at);
CREATE INDEX inv_batch_reservation ON studio.inv_batch (org_id, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX inv_movement_batch ON studio.inv_movement (org_id, batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE studio.inv_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_batch USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());

-- written once, like the ledger
GRANT SELECT, INSERT ON studio.inv_batch TO studio_app;
GRANT SELECT ON studio.inv_batch TO studio_ro;
