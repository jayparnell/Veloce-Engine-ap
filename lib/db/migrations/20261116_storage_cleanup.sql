CREATE TABLE IF NOT EXISTS storage_cleanups (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL DEFAULT 'preview',
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS storage_cleanup_owner_recent ON storage_cleanups(owner_id, created_at);
