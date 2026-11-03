-- Where the map's nodes sit and how it is zoomed/panned, so the arrangement follows the data
-- across browsers and devices. One shared row; last write wins (it is a view setting, not data).
CREATE TABLE IF NOT EXISTS layout_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  layout text NOT NULL DEFAULT 'grouped',
  positions jsonb NOT NULL DEFAULT '{}'::jsonb,
  view jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
