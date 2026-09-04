-- Run once (deepline tools describe query_customer_db) instead of per event.
CREATE SCHEMA IF NOT EXISTS sales;
CREATE TABLE IF NOT EXISTS sales.sales_nav_imports (
  import_id text NOT NULL,
  lead_key text NOT NULL,
  imported_by text,
  imported_at timestamptz,
  import_kind text,
  search_url text,
  search_name text,
  list_id text,
  page integer,
  full_name text,
  first_name text,
  last_name text,
  title text,
  company_name text,
  linkedin_url text,
  sales_navigator_url text,
  location text,
  email text,
  event_id text,
  status text NOT NULL DEFAULT 'received',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, lead_key)
);
CREATE INDEX IF NOT EXISTS sales_nav_imports_lead_key ON sales.sales_nav_imports (lead_key);
