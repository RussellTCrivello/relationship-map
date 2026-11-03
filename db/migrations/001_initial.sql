CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS entities (
 id text PRIMARY KEY, name text NOT NULL, type text NOT NULL DEFAULT 'Thing', attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS relationships (
 id text PRIMARY KEY, source_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
 target_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE, type text NOT NULL DEFAULT 'Other',
 attributes jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS entities_name_idx ON entities USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);
CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships(target_entity_id);
