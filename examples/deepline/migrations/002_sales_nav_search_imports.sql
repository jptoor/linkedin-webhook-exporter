-- Run once. One row per forwarded search (the extension's "Import search").
CREATE SCHEMA IF NOT EXISTS sales;
CREATE TABLE IF NOT EXISTS sales.sales_nav_search_imports (
  import_id text PRIMARY KEY,
  imported_by text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  search_url text NOT NULL,
  search_name text,
  saved_search_id text,
  requested_limit integer,
  total_hint integer,
  provider_task_id text,
  result_count integer,
  status text NOT NULL DEFAULT 'received',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_nav_search_imports_by ON sales.sales_nav_search_imports (imported_by, imported_at DESC);
