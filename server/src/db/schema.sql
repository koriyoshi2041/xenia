-- Current service storage (node:sqlite). JSON data preserves signed policy documents
-- and complete transaction parameters. The index is rebuildable from EAS events.
CREATE TABLE IF NOT EXISTS runtime_queues (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_items (
  queue_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (queue_id, number)
);
CREATE TABLE IF NOT EXISTS contributions (
  uid TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY
);
