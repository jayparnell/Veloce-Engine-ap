-- Additive and repeatable; output receipts deliberately survive media deletion.
CREATE TABLE IF NOT EXISTS automation_settings (
  owner_id text PRIMARY KEY,
  daily_render_cap integer NOT NULL DEFAULT 15 CHECK (daily_render_cap BETWEEN 0 AND 1000)
);
CREATE TABLE IF NOT EXISTS render_reservations (
  output_key text PRIMARY KEY, owner_id text NOT NULL, job_id integer, moment_index integer,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS render_owner ON render_reservations(owner_id);
ALTER TABLE autopilot_jobs ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
ALTER TABLE autopilot_jobs ADD COLUMN IF NOT EXISTS retry_at timestamptz;
ALTER TABLE autopilot_jobs ADD COLUMN IF NOT EXISTS failure_kind text;
ALTER TABLE autopilot_publish_queue ADD COLUMN IF NOT EXISTS failure_kind text;
-- Previous attempts counted polls, not failures. Convert once, preserving safety holds.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='autopilot_publish_queue' AND column_name='failure_count_version') THEN
    UPDATE autopilot_publish_queue SET attempts=0;
    ALTER TABLE autopilot_publish_queue ADD COLUMN failure_count_version integer NOT NULL DEFAULT 1;
  END IF;
END $$;
INSERT INTO render_reservations(output_key,owner_id,job_id,moment_index,completed_at)
  SELECT CASE WHEN job_id IS NOT NULL AND moment_index IS NOT NULL
    THEN 'job:'||job_id||':'||moment_index ELSE 'legacy-clip:'||id END,
    owner_id,job_id,moment_index,created_at FROM generated_clips WHERE demo=false
  ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS autopilot_retry_claim ON autopilot_jobs(status,retry_at,id)
  WHERE cancel_requested=false AND status IN ('queued','retry','budget_paused');
