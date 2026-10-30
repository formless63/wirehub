-- Generated from specs/postgres-backend.md §3 and docs/inventory.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0028_inventory — workshop inventory (docs/inventory.md, server/inventory/)
-- Locations (a tree), lots of a library item with their balances materialised from the
-- ledger, the append-only ledger of movements, and reservations against a design build.
-- Not catalog tables: no change set, catalog export or git mirror reads them. Quantities are
-- in the lot's base unit (ea, mm or g). The app may append to the ledger and never change it.
CREATE TABLE studio.inv_location (
  org_id      uuid NOT NULL REFERENCES studio.org,
  id          text NOT NULL CHECK (id ~ '^loc-[0-9a-f]{10}$'),
  parent_id   text,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  note        text CHECK (length(note) <= 2000),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, parent_id) REFERENCES studio.inv_location (org_id, id)
);

CREATE TABLE studio.inv_lot (
  org_id       uuid NOT NULL REFERENCES studio.org,
  id           text NOT NULL CHECK (id ~ '^lot-[0-9a-f]{10}$'),
  item_kind    text NOT NULL CHECK (item_kind IN ('connectors', 'wires', 'components', 'pcbas', 'mechanicals', 'designs')),
  item_id      text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  dim          text NOT NULL CHECK (dim IN ('count', 'length', 'mass')),
  location_id  text NOT NULL,
  lot_code     text CHECK (length(lot_code) <= 120),
  supplier     text CHECK (length(supplier) <= 120),
  supplier_ref text CHECK (length(supplier_ref) <= 120),
  unit_cost    numeric CHECK (unit_cost >= 0),
  currency     text CHECK (length(currency) <= 8),
  note         text CHECK (length(note) <= 2000),
  parent_lot   text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  on_hand      numeric NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     numeric NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  version      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES studio.inv_location (org_id, id)
);
CREATE INDEX inv_lot_item ON studio.inv_lot (org_id, item_kind, item_id);
CREATE INDEX inv_lot_location ON studio.inv_lot (org_id, location_id);

CREATE TABLE studio.inv_movement (
  org_id          uuid NOT NULL REFERENCES studio.org,
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL CHECK (length(actor) <= 320),
  kind            text NOT NULL CHECK (kind IN ('receive', 'move', 'split', 'adjust', 'consume', 'return')),
  lot_id          text NOT NULL,
  item_kind       text NOT NULL,
  item_id         text NOT NULL,
  qty             numeric NOT NULL,
  on_hand_after   numeric NOT NULL,
  from_location   text,
  to_location     text,
  reason          text CHECK (length(reason) <= 500),
  reservation_id  text,
  other_lot       text,
  note            text CHECK (length(note) <= 2000),
  PRIMARY KEY (org_id, seq),
  FOREIGN KEY (org_id, lot_id) REFERENCES studio.inv_lot (org_id, id)
);
CREATE INDEX inv_movement_lot ON studio.inv_movement (org_id, lot_id, seq);
CREATE INDEX inv_movement_item ON studio.inv_movement (org_id, item_kind, item_id, seq);
CREATE INDEX inv_movement_reservation ON studio.inv_movement (org_id, reservation_id) WHERE reservation_id IS NOT NULL;

CREATE TABLE studio.inv_reservation (
  org_id      uuid NOT NULL REFERENCES studio.org,
  id          text NOT NULL CHECK (id ~ '^res-[0-9a-f]{10}$'),
  design_id   text NOT NULL,
  design_rev  integer,
  build_qty   numeric NOT NULL CHECK (build_qty > 0),
  label       text CHECK (length(label) <= 200),
  status      text NOT NULL CHECK (status IN ('open', 'closed')),
  allowance   jsonb NOT NULL,
  lines       jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND pg_column_size(lines) <= 1048576),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  closed_at   timestamptz,
  version     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX inv_reservation_design ON studio.inv_reservation (org_id, design_id, status);

ALTER TABLE studio.inv_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_location FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_location USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
ALTER TABLE studio.inv_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_lot FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_lot USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
ALTER TABLE studio.inv_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_movement USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());
ALTER TABLE studio.inv_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_reservation FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_reservation USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.inv_location, studio.inv_reservation TO studio_app;
GRANT SELECT, INSERT, UPDATE ON studio.inv_lot TO studio_app;
-- the ledger is append-only for the app
GRANT SELECT, INSERT ON studio.inv_movement TO studio_app;
GRANT SELECT ON studio.inv_location, studio.inv_lot, studio.inv_movement, studio.inv_reservation TO studio_ro;
