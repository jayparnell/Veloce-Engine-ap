ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS posting_route text NOT NULL DEFAULT 'direct';
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS unified_account_id text;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS unified_profile_id text;
ALTER TABLE autopilot_publish_queue ADD COLUMN IF NOT EXISTS remote_url text;
CREATE TABLE IF NOT EXISTS unified_posting_settings (
  owner_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('ayrshare','late')),
  credential_hash text NOT NULL,
  discovery jsonb NOT NULL DEFAULT '[]',
  discovered_at timestamptz
);
