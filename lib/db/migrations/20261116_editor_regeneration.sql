ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS render_info jsonb;
ALTER TABLE generated_clips ADD COLUMN IF NOT EXISTS regeneration_job_id integer;
