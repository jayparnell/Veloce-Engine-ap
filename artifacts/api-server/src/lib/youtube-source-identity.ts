import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { youtubeVideoId } from "./youtube-feed-client";

export class DuplicateYoutubeSource extends Error {
  constructor() { super("This YouTube video was already submitted in your workspace. Review its existing job instead of admitting a duplicate."); }
}
/** Call under the shared owner admission lock, in the same transaction as source creation. */
export async function recordYoutubeSubmission(tx: Pick<typeof db, "execute">, owner: string, source: string, projectId: number, jobId: number | null) {
  const id = youtubeVideoId(source);
  if (!id) return;
  const result = await tx.execute(sql`INSERT INTO youtube_sources(owner_id,video_id,title,state,project_id,job_id)
    VALUES(${owner},${id},'Submitted YouTube source','admitted',${projectId},${jobId})
    ON CONFLICT(owner_id,video_id) DO UPDATE SET state='admitted',project_id=excluded.project_id,job_id=excluded.job_id,reason=NULL,retry_at=NULL
    WHERE youtube_sources.state='pending' RETURNING video_id`);
  if (!result.rowCount) throw new DuplicateYoutubeSource();
}
