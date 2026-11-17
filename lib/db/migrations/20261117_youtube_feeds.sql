CREATE TABLE IF NOT EXISTS youtube_subscriptions (
  id serial PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('channel','playlist')),
  provider_id text NOT NULL,
  feed_url text NOT NULL,
  title text NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  baseline_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  error text,
  etag text,
  last_modified text,
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,kind,provider_id)
);
CREATE INDEX IF NOT EXISTS youtube_feed_due ON youtube_subscriptions(next_poll_at) WHERE paused=false;
-- No media foreign keys: deleting projects must not re-admit a previously submitted identity.
CREATE TABLE IF NOT EXISTS youtube_sources (
  owner_id text NOT NULL,
  video_id text NOT NULL,
  title text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','admitted')),
  project_id integer,
  job_id integer,
  reason text,
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,video_id)
);
CREATE INDEX IF NOT EXISTS youtube_sources_pending ON youtube_sources(owner_id,created_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS youtube_feed_entries (
  subscription_id integer NOT NULL REFERENCES youtube_subscriptions(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  baseline boolean NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id,video_id)
);
-- Backfill existing real submissions, not the feed's historical window.
INSERT INTO youtube_sources(owner_id,video_id,title,state,project_id,job_id)
SELECT DISTINCT ON (owner_id,video_id) owner_id,video_id,title,'admitted',project_id,job_id
FROM (
  SELECT p.owner_id,p.title,p.id AS project_id,j.id AS job_id,
    CASE
      WHEN p.source_url ~ '^https://youtu\.be/' THEN substring(p.source_url FROM '^https://youtu\.be/([A-Za-z0-9_-]{11})(?:[?#]|$)')
      WHEN p.source_url ~ '^https://(www\.|m\.)?youtube\.com/watch\?' THEN substring(p.source_url FROM '[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)')
      ELSE substring(p.source_url FROM '^https://(?:www\.|m\.)?youtube\.com/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})(?:[/?#]|$)')
    END AS video_id
  FROM projects p LEFT JOIN autopilot_jobs j ON j.project_id=p.id AND j.original_clip_id IS NULL
  WHERE p.demo=false
) existing WHERE video_id IS NOT NULL
ORDER BY owner_id,video_id,project_id
ON CONFLICT(owner_id,video_id) DO NOTHING;
