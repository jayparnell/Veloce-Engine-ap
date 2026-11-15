import { db, projectsTable, analyticsLogsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { runDemo, runMedia } from "./process";

let busy = false;
export function startPipelineWorker() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      // A heartbeat distinguishes interrupted jobs from a slow running renderer.
      await db.execute(sql`UPDATE projects SET status='failed', error='Processing was interrupted. Please retry this batch.', updated_at=now() WHERE status='processing' AND updated_at < now() - interval '5 minutes'`);
      const project = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('veloce-worker-claim'))`);
        const active = await tx.execute(sql`SELECT id FROM projects WHERE status='processing' LIMIT 1`);
        if (active.rows.length) return null;
        const candidate = await tx.execute(sql`SELECT id FROM projects WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
        if (!candidate.rows.length) return null;
        const id = Number(candidate.rows[0]!.id);
        const [row] = await tx.update(projectsTable).set({ status: "processing", updatedAt: new Date() }).where(eq(projectsTable.id, id)).returning();
        return row;
      });
      if (!project) return;
      heartbeat = setInterval(() => {
        void db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, project.id)).catch(() => {});
      }, 30000);
      try {
        if (project.demo) await runDemo(project); else await runMedia(project);
        await db.update(projectsTable).set({ status: "completed", stage: 5, progress: 100, updatedAt: new Date() }).where(eq(projectsTable.id, project.id));
        await db.insert(analyticsLogsTable).values({ ownerId: project.ownerId, message: `${project.demo ? "Demo batch" : "Media batch"} completed: ${project.clipCount} clips available in the vault.` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Media processing failed.";
        // Do not leak SDK request payloads, paths or credentials into client errors.
        const safe = /^(Media |The source |No |Source |Voiceover |Processing |You do not|Upload |The rendered)/.test(message) ? message.slice(0, 250) : "AI or media processing failed. Check source access and retry; no video was marked ready.";
        logger.warn({ projectId: project.id, errorName: error instanceof Error ? error.name : "Unknown" }, "Production batch failed");
        await db.update(projectsTable).set({ status: "failed", error: safe, updatedAt: new Date() }).where(eq(projectsTable.id, project.id));
        await db.insert(analyticsLogsTable).values({ ownerId: project.ownerId, message: `Batch ${project.id} failed. ${safe}` });
      }
    } catch (err) { logger.error({ errorName: err instanceof Error ? err.name : "Unknown" }, "Pipeline worker failed"); }
    finally { if (heartbeat) clearInterval(heartbeat); busy = false; }
  };
  const interval = setInterval(() => { void tick(); }, 2000);
  interval.unref();
  void tick();
}
