CREATE TABLE IF NOT EXISTS storage_object_index (
  scope text NOT NULL,
  object_path text NOT NULL,
  owner_id text NOT NULL,
  metadata jsonb NOT NULL,
  seen_run text NOT NULL,
  PRIMARY KEY(scope, object_path)
);
CREATE INDEX IF NOT EXISTS storage_objects_owner_path ON storage_object_index(scope, owner_id, object_path);
CREATE TABLE IF NOT EXISTS storage_inventory_state (
  scope text PRIMARY KEY,
  page_token text,
  run_id text NOT NULL,
  completed_at timestamptz,
  advanced_at timestamptz
);
CREATE TABLE IF NOT EXISTS storage_object_references (
  source_table text NOT NULL,
  source_id text NOT NULL,
  object_path text NOT NULL,
  final boolean NOT NULL DEFAULT false,
  PRIMARY KEY(source_table, source_id, object_path)
);
CREATE INDEX IF NOT EXISTS storage_references_path ON storage_object_references(object_path);
-- A reservation survives network failures and process death. Never automatically replay it.
CREATE TABLE IF NOT EXISTS storage_object_fences (
  object_path text PRIMARY KEY,
  cleanup_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE storage_cleanups ADD COLUMN IF NOT EXISTS outcomes jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS storage_cleanup_owner_cursor ON storage_cleanups(owner_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION storage_paths(value jsonb) RETURNS SETOF text
LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT m[1] FROM regexp_matches(value::text, '/objects/[a-zA-Z0-9/_-]+', 'g') m
$$;
CREATE OR REPLACE FUNCTION storage_reference_id(t text, value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t='autopilot_ai_calls' THEN jsonb_build_array(value->'job_id',value->'call_key')::text
    WHEN t='media_uploads' THEN value->>'object_path' ELSE value->>'id' END
$$;

CREATE OR REPLACE FUNCTION storage_track_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  p text;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'autopilot_jobs' THEN
    FOR p IN SELECT DISTINCT v FROM (VALUES(old_row->>'owner_id'),(new_row->>'owner_id')) owners(v)
      WHERE v IS NOT NULL ORDER BY v LOOP
      PERFORM pg_advisory_xact_lock_shared(hashtextextended(p,74021));
    END LOOP;
  END IF;
  -- Same lock order as cleanup; hash collisions only reduce concurrency, never safety.
  FOR p IN SELECT storage_paths(jsonb_build_array(old_row,new_row)) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(p, 74019));
  END LOOP;
  FOR p IN SELECT storage_paths(new_row) LOOP
    IF EXISTS (SELECT 1 FROM storage_object_fences WHERE object_path = p) THEN
      RAISE EXCEPTION 'Object is reserved for cleanup; generate or upload a new asset';
    END IF;
  END LOOP;
  DELETE FROM storage_object_references
    WHERE source_table = TG_TABLE_NAME AND source_id = storage_reference_id(TG_TABLE_NAME,COALESCE(old_row,new_row));
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO storage_object_references(source_table, source_id, object_path, final)
    SELECT TG_TABLE_NAME, storage_reference_id(TG_TABLE_NAME,new_row), path,
      TG_TABLE_NAME = 'generated_clips' AND path IN (
        SELECT storage_paths(jsonb_build_array(new_row->'object_path',new_row->'video_url',new_row->'thumbnail',
          new_row->'voiceover_object_path',new_row->'captions_object_path')))
    FROM storage_paths(new_row) path;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION storage_truncate_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM storage_object_references WHERE source_table = TG_TABLE_NAME;
  RETURN NULL;
END $$;
-- Lock and backfill once, atomically with trigger installation. Re-running does not rescan.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','source_videos','generated_clips','monetization_campaigns',
    'autopilot_jobs','autopilot_ai_calls','autopilot_publish_queue','media_uploads'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = t::regclass AND tgname = 'storage_reference_changes') THEN
      EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',t);
      EXECUTE format('INSERT INTO storage_object_references SELECT %L, storage_reference_id(%L,to_jsonb(r)), p,
        %L = ''generated_clips'' AND p IN (SELECT storage_paths(jsonb_build_array(to_jsonb(r)->''object_path'',
        to_jsonb(r)->''video_url'',to_jsonb(r)->''thumbnail'',to_jsonb(r)->''voiceover_object_path'',
        to_jsonb(r)->''captions_object_path''))) FROM %I r CROSS JOIN LATERAL storage_paths(to_jsonb(r)) p
        ON CONFLICT DO NOTHING',t,t,t,t);
      EXECUTE format('CREATE TRIGGER storage_reference_changes AFTER INSERT OR UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION storage_track_references()',t);
      EXECUTE format('CREATE TRIGGER storage_reference_truncate AFTER TRUNCATE ON %I
        FOR EACH STATEMENT EXECUTE FUNCTION storage_truncate_references()',t);
    END IF;
  END LOOP;
END $$;
