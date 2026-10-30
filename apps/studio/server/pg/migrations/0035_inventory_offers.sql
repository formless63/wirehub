-- Generated from specs/postgres-backend.md §3 and docs/inventory.md. Never edit after release:
-- a change is a new migration (§6; migrations/CHECKSUMS).
-- 0035_inventory_offers — dated supplier offers per library item (server/sourcing/offers.ts).
-- Optional sourcing facts beside the inventory, never catalog data: the price, its currency and the
-- pack may each be unknown. An offer is written once; a newer price is a newer row.
CREATE TABLE studio.inv_offer (
  org_id        uuid NOT NULL REFERENCES studio.org,
  id            text NOT NULL CHECK (id ~ '^off-[0-9a-f]{10}$'),
  item_kind     text NOT NULL CHECK (item_kind IN ('connectors', 'wires', 'components', 'pcbas', 'mechanicals', 'designs')),
  item_id       text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  supplier      text NOT NULL CHECK (length(supplier) BETWEEN 1 AND 120),
  supplier_ref  text CHECK (length(supplier_ref) <= 120),
  offered_on    date NOT NULL,
  price         numeric CHECK (price >= 0),
  currency      text CHECK (currency ~ '^[A-Z]{3}$'),
  unit          text NOT NULL CHECK (length(unit) BETWEEN 1 AND 8),
  pack          numeric CHECK (pack > 0),
  note          text CHECK (length(note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL CHECK (length(created_by) <= 320),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX inv_offer_item ON studio.inv_offer (org_id, item_kind, item_id, offered_on DESC);

ALTER TABLE studio.inv_offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio.inv_offer FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON studio.inv_offer USING (org_id = studio.current_org()) WITH CHECK (org_id = studio.current_org());

GRANT SELECT, INSERT, DELETE ON studio.inv_offer TO studio_app;
GRANT SELECT ON studio.inv_offer TO studio_ro;
