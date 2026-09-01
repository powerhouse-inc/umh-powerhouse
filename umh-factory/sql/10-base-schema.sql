-- Base UNS tables. Upstream these are created lazily by umh-core's dataflow
-- init_statements at first connect — which runs AFTER the database exists. In
-- this compose the init SQL runs FIRST (initdb), so the later files (views,
-- hypertables) need these to exist already. DDL is verbatim from the
-- dataflows' init_statement, so the lazy CREATE IF NOT EXISTS there stays a
-- no-op.
CREATE TABLE IF NOT EXISTS asset (
  id SERIAL PRIMARY KEY,
  enterprise VARCHAR(255) NOT NULL,
  site VARCHAR(255) DEFAULT '',
  area VARCHAR(255) DEFAULT '',
  line VARCHAR(255) DEFAULT '',
  workcell VARCHAR(255) DEFAULT '',
  origin_id VARCHAR(255) DEFAULT '',
  UNIQUE (enterprise, site, area, line, workcell, origin_id)
);
CREATE TABLE IF NOT EXISTS tag (
  timestamp TIMESTAMPTZ NOT NULL,
  asset_id INTEGER REFERENCES asset(id),
  name TEXT NOT NULL,
  value DOUBLE PRECISION,
  origin VARCHAR(255)
);
CREATE TABLE IF NOT EXISTS tag_string (
  timestamp TIMESTAMPTZ NOT NULL,
  asset_id INTEGER REFERENCES asset(id),
  name TEXT NOT NULL,
  value TEXT,
  origin VARCHAR(255)
);
