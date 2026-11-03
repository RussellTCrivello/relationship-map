-- Preserve insertion order and track a revision of the whole graph so concurrent
-- writers (two tabs / devices) cannot silently overwrite each other.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS seq bigserial;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS entities_seq_idx ON entities(seq);
CREATE INDEX IF NOT EXISTS relationships_seq_idx ON relationships(seq);

CREATE TABLE IF NOT EXISTS graph_meta (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  last_request_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO graph_meta (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
