import { sql } from "drizzle-orm";

/** Include older queued projects until the worker adopts them, without double-counting adopted sources. */
export function autopilotUsage(owner: string) {
  return sql`WITH work AS (
    SELECT status,created_at FROM autopilot_jobs WHERE owner_id=${owner}
    UNION ALL
    SELECT p.status,p.created_at FROM projects p WHERE p.owner_id=${owner} AND p.demo=false
      AND NOT EXISTS (SELECT 1 FROM autopilot_jobs j WHERE j.project_id=p.id AND j.owner_id=${owner} AND j.original_clip_id IS NULL)
  ) SELECT count(*) FILTER (WHERE status IN ('queued','processing','uncertain')) AS active,
    (SELECT count(*) FROM autopilot_admissions WHERE owner_id=${owner} AND created_at>now()-interval '24 hours') AS daily FROM work`;
}
