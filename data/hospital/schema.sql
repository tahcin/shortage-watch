-- Hospital pharmacy sample schema (PostgreSQL 16).
-- SAMPLE DATA lives in seed.sql; this file is structure only.

CREATE TABLE formulary (
  item_id serial PRIMARY KEY,
  generic_name text NOT NULL,
  strength text,
  dosage_form text,
  route text,
  package_ndc text UNIQUE,
  product_ndc text,
  labeler text,
  therapeutic_class text,
  is_critical boolean NOT NULL DEFAULT false
);

CREATE TABLE inventory (
  item_id int NOT NULL REFERENCES formulary (item_id),
  location text NOT NULL,
  on_hand_units int NOT NULL CHECK (on_hand_units >= 0),
  snapshot_at timestamptz NOT NULL
);

CREATE TABLE usage_daily (
  item_id int NOT NULL REFERENCES formulary (item_id),
  day date NOT NULL,
  units_used int NOT NULL CHECK (units_used >= 0),
  PRIMARY KEY (item_id, day)
);

CREATE TABLE purchase_orders (
  po_id text PRIMARY KEY,
  item_id int NOT NULL REFERENCES formulary (item_id),
  wholesaler text NOT NULL,
  ordered_units int NOT NULL CHECK (ordered_units > 0),
  ordered_on date NOT NULL,
  expected_on date,
  status text NOT NULL CHECK (status IN ('open', 'backordered', 'received'))
);

CREATE VIEW days_of_cover AS
SELECT
  f.item_id,
  f.generic_name,
  COALESCE(inv.on_hand_units, 0) AS on_hand_units,
  avg_use.avg_daily_use,
  CASE
    WHEN avg_use.avg_daily_use IS NULL OR avg_use.avg_daily_use = 0 THEN NULL
    ELSE COALESCE(inv.on_hand_units, 0)::numeric / avg_use.avg_daily_use
  END AS days_of_cover
FROM formulary f
LEFT JOIN LATERAL (
  SELECT SUM(i.on_hand_units) AS on_hand_units
  FROM inventory i
  WHERE i.item_id = f.item_id
) inv ON true
LEFT JOIN LATERAL (
  SELECT AVG(u.units_used)::numeric AS avg_daily_use
  FROM usage_daily u
  WHERE u.item_id = f.item_id
    AND u.day >= (CURRENT_DATE - INTERVAL '30 days')
) avg_use ON true;
