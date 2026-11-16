-- Additive, repeatable, and independent of media lifetime.
ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS daily_request_unit_limit integer
  CHECK (daily_request_unit_limit BETWEEN 0 AND 10000);
CREATE TABLE IF NOT EXISTS autopilot_ai_usage (
  id serial PRIMARY KEY, owner_id text NOT NULL, job_id integer NOT NULL, project_id integer NOT NULL,
  source_title text NOT NULL, language text NOT NULL, category text NOT NULL,
  call_key text NOT NULL, status text NOT NULL DEFAULT 'started', units integer NOT NULL DEFAULT 1,
  model text, metrics jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_owner_recent ON autopilot_ai_usage(owner_id,created_at);
CREATE INDEX IF NOT EXISTS ai_usage_job ON autopilot_ai_usage(job_id);
ALTER TABLE autopilot_ai_calls ADD COLUMN IF NOT EXISTS usage_id integer;
-- Historical checkpoints have unknown metrics. Link each exactly once, even across reruns.
DO $$ DECLARE r record; receipt integer;
BEGIN
  FOR r IN SELECT c.job_id,c.call_key,c.status,c.updated_at,j.owner_id,j.project_id,j.language,p.title
    FROM autopilot_ai_calls c JOIN autopilot_jobs j ON j.id=c.job_id JOIN projects p ON p.id=j.project_id
    WHERE c.usage_id IS NULL FOR UPDATE OF c
  LOOP
    INSERT INTO autopilot_ai_usage(owner_id,job_id,project_id,source_title,language,category,call_key,status,created_at)
      VALUES(r.owner_id,r.job_id,r.project_id,r.title,r.language,
        CASE WHEN r.language IN ('es','pt') THEN r.language
          WHEN r.call_key LIKE 'voice:%' OR r.call_key='editor-voice' THEN 'narration' ELSE 'source' END,
        r.call_key,CASE WHEN r.status='done' THEN 'done' ELSE 'uncertain' END,r.updated_at)
      RETURNING id INTO receipt;
    UPDATE autopilot_ai_calls SET usage_id=receipt WHERE job_id=r.job_id AND call_key=r.call_key;
  END LOOP;
END $$;
