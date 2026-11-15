import { Router, type IRouter } from "express";
import { db, schedulesTable, generatedClipsTable, platformAccountsTable, trainingProgressTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { ListSchedulesResponse, CreateScheduleBody, CreateScheduleResponse, DeleteScheduleParams, ListPlatformAccountsResponse, GetPlaybookResponse, UpdateLessonParams, UpdateLessonBody, UpdateLessonResponse } from "@workspace/api-zod";
import { lessons } from "../lib/demo";

const router: IRouter = Router();
router.get("/schedules", async (req, res): Promise<void> => {
  const rows = await db.select({ schedule: schedulesTable, title: generatedClipsTable.title }).from(schedulesTable).innerJoin(generatedClipsTable, eq(schedulesTable.clipId, generatedClipsTable.id)).where(eq(schedulesTable.ownerId, req.workspaceId)).orderBy(asc(schedulesTable.scheduledAt));
  res.json(ListSchedulesResponse.parse(rows.map(({ schedule, title }) => ({ ...schedule, title, scheduledAt: schedule.scheduledAt.toISOString() }))));
});
router.post("/schedules", async (req, res): Promise<void> => {
  const parsed = CreateScheduleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a clip, platform and valid date." }); return; }
  const scheduledAt = new Date(parsed.data.scheduledAt);
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) { res.status(400).json({ error: "Choose a future publishing time." }); return; }
  const [clip] = await db.select().from(generatedClipsTable).where(and(eq(generatedClipsTable.id, parsed.data.clipId), eq(generatedClipsTable.ownerId, req.workspaceId)));
  if (!clip) { res.status(404).json({ error: "Clip not found." }); return; }
  const [row] = await db.insert(schedulesTable).values({ ...parsed.data, scheduledAt, ownerId: req.workspaceId, status: "draft", demo: clip.demo }).returning();
  res.status(201).json(CreateScheduleResponse.parse({ ...row, title: clip.title, scheduledAt: scheduledAt.toISOString() }));
});
router.delete("/schedules/:id", async (req, res): Promise<void> => {
  const parsed = DeleteScheduleParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid publishing draft." }); return; }
  const [row] = await db.delete(schedulesTable).where(and(eq(schedulesTable.id, parsed.data.id), eq(schedulesTable.ownerId, req.workspaceId))).returning();
  if (!row) { res.status(404).json({ error: "Publishing draft not found." }); return; }
  res.sendStatus(204);
});
router.get("/accounts", async (req, res): Promise<void> => {
  const accounts = await db.select().from(platformAccountsTable).where(eq(platformAccountsTable.ownerId, req.workspaceId)).orderBy(asc(platformAccountsTable.id));
  res.json(ListPlatformAccountsResponse.parse(accounts.map((a) => ({ ...a, message: a.connected ? "Account authorized. Automatic posting is not enabled; export and upload manually." : "Configure OAuth in Settings after platform approval. Export packages and upload manually for now." }))));
});
router.get("/playbook", async (req, res): Promise<void> => {
  const progress = await db.select().from(trainingProgressTable).where(eq(trainingProgressTable.ownerId, req.workspaceId));
  res.json(GetPlaybookResponse.parse(lessons.map((lesson) => ({ ...lesson, completed: progress.find((p) => p.lessonId === lesson.id)?.completed ?? false }))));
});
router.patch("/playbook/:id", async (req, res): Promise<void> => {
  const params = UpdateLessonParams.safeParse(req.params);
  const parsed = UpdateLessonBody.safeParse(req.body);
  if (!params.success || !parsed.success) { res.status(400).json({ error: "Invalid lesson progress." }); return; }
  const lesson = lessons.find((l) => l.id === params.data.id);
  if (!lesson) { res.status(404).json({ error: "Lesson not found." }); return; }
  await db.insert(trainingProgressTable).values({ ownerId: req.workspaceId, lessonId: lesson.id, completed: parsed.data.completed }).onConflictDoUpdate({ target: [trainingProgressTable.ownerId, trainingProgressTable.lessonId], set: parsed.data });
  res.json(UpdateLessonResponse.parse({ ...lesson, completed: parsed.data.completed }));
});
export default router;
