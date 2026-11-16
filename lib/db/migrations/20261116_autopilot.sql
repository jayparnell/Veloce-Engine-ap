-- Additive only. Never drop or rewrite existing users, sessions, projects or media.
ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS job_id integer;
ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS moment_index integer;
ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS original_clip_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS clip_job_moment ON generated_clips(job_id,moment_index);
CREATE TABLE IF NOT EXISTS autopilot_jobs (
  id serial PRIMARY KEY, owner_id text NOT NULL, project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_key text NOT NULL, input_hash text NOT NULL, language text NOT NULL DEFAULT 'en',
  original_clip_id integer REFERENCES generated_clips(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued', stage text NOT NULL DEFAULT 'accepted', progress integer NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}', notice text NOT NULL DEFAULT '', error text, lease_token text,
  lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_owner_request ON autopilot_jobs(owner_id,request_key);
CREATE INDEX IF NOT EXISTS autopilot_project ON autopilot_jobs(project_id);
CREATE INDEX IF NOT EXISTS autopilot_owner_recent ON autopilot_jobs(owner_id,id);
CREATE INDEX IF NOT EXISTS autopilot_claim ON autopilot_jobs(status,lease_until,id) WHERE status IN ('queued','processing') AND cancel_requested=false;
CREATE TABLE IF NOT EXISTS autopilot_admissions (
  id serial PRIMARY KEY, owner_id text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL,
  job_id integer, project_id integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS admission_owner_request ON autopilot_admissions(owner_id,request_key);
CREATE INDEX IF NOT EXISTS admission_owner_created ON autopilot_admissions(owner_id,created_at);
-- Durable usage receipts deliberately survive media deletion; no source URLs or credentials are stored.
INSERT INTO autopilot_admissions(owner_id,request_key,input_hash,job_id,project_id,created_at)
  SELECT owner_id,request_key,input_hash,id,project_id,created_at FROM autopilot_jobs ON CONFLICT DO NOTHING;
INSERT INTO autopilot_admissions(owner_id,request_key,input_hash,project_id,created_at)
  SELECT p.owner_id,'legacy:'||p.id,'legacy',p.id,p.created_at FROM projects p WHERE p.demo=false
    AND NOT EXISTS(SELECT 1 FROM autopilot_jobs j WHERE j.project_id=p.id AND j.original_clip_id IS NULL)
  ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS autopilot_ai_calls (
  job_id integer NOT NULL REFERENCES autopilot_jobs(id) ON DELETE CASCADE,
  call_key text NOT NULL, status text NOT NULL, result jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_ai_call ON autopilot_ai_calls(job_id,call_key);
CREATE TABLE IF NOT EXISTS social_accounts (
  id serial PRIMARY KEY, owner_id text NOT NULL, provider text NOT NULL, platform text NOT NULL,
  remote_account_id text NOT NULL, handle text NOT NULL, encrypted_tokens text, expires_at timestamptz, scopes text NOT NULL,
  approved boolean NOT NULL DEFAULT false, connected boolean NOT NULL DEFAULT true, auto_enabled boolean NOT NULL DEFAULT false,
  include_dubs boolean NOT NULL DEFAULT false, timezone text NOT NULL DEFAULT 'America/New_York', slots jsonb NOT NULL, error text
);
CREATE UNIQUE INDEX IF NOT EXISTS social_owner_remote ON social_accounts(owner_id,provider,remote_account_id);
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS auto_enabled_at timestamptz;
CREATE TABLE IF NOT EXISTS autopilot_publish_queue (
  id serial PRIMARY KEY, owner_id text NOT NULL, account_id integer NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  clip_id integer NOT NULL REFERENCES generated_clips(id) ON DELETE CASCADE, scheduled_at timestamptz NOT NULL, timezone text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled', remote_id text, checkpoint jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0, retry_at timestamptz, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS publish_account_clip ON autopilot_publish_queue(account_id,clip_id);
CREATE UNIQUE INDEX IF NOT EXISTS publish_account_slot ON autopilot_publish_queue(account_id,scheduled_at);
CREATE INDEX IF NOT EXISTS publish_due ON autopilot_publish_queue(scheduled_at,retry_at) WHERE status IN ('scheduled','processing','publishing','retry');
CREATE TABLE IF NOT EXISTS autopilot_services (name text PRIMARY KEY,heartbeat_at timestamptz NOT NULL DEFAULT now());
