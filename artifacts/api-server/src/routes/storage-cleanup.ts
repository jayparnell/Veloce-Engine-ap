import { Router, type IRouter } from "express";
import { PreviewStorageCleanupBody, ConfirmStorageCleanupBody, GetStorageReportResponse,
  ListStorageCleanupsResponse, ConfirmStorageCleanupResponse, PreviewStorageCleanupResponse,
  GetStorageReportQueryParams, ListStorageCleanupsQueryParams, GetStorageCleanupQueryParams,
  GetStorageCleanupParams, GetStorageCleanupResponse } from "@workspace/api-zod";
import { storageReport, cleanupHistory, cleanupDetail, confirmCleanup, CleanupConflict } from "../lib/storage-cleanup";

const router: IRouter = Router();
router.use("/storage", (req, res, next) => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Sign in to manage storage." }); return; }
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/storage/report", async (req, res): Promise<void> => {
  const parsed = GetStorageReportQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid inventory page." }); return; }
  res.json(GetStorageReportResponse.parse(await storageReport(req.workspaceId, undefined, false, parsed.data.cursor, parsed.data.limit)));
});
router.get("/storage/cleanup/history", async (req, res): Promise<void> => {
  const parsed = ListStorageCleanupsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid history page." }); return; }
  res.json(ListStorageCleanupsResponse.parse(await cleanupHistory(req.workspaceId, parsed.data.cursor, parsed.data.limit)));
});
router.get("/storage/cleanup/history/:id", async (req, res): Promise<void> => {
  const params = GetStorageCleanupParams.safeParse(req.params);
  const query = GetStorageCleanupQueryParams.safeParse(req.query);
  if (!params.success || !query.success) { res.status(400).json({ error: "Invalid history page." }); return; }
  const report = await cleanupDetail(req.workspaceId, params.data.id, query.data.cursor, query.data.limit);
  if (!report) { res.status(404).json({ error: "Not found." }); return; }
  res.json(GetStorageCleanupResponse.parse(report));
});
router.post("/storage/cleanup/preview", async (req, res): Promise<void> => {
  const parsed = PreviewStorageCleanupBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose keep everything or an age of 7–3650 days." }); return; }
  res.json(PreviewStorageCleanupResponse.parse(await storageReport(req.workspaceId, parsed.data, true)));
});
router.post("/storage/cleanup/confirm", async (req, res): Promise<void> => {
  const parsed = ConfirmStorageCleanupBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid confirmation." }); return; }
  try {
    const { reportId, objectPaths, confirmation } = parsed.data;
    res.json(ConfirmStorageCleanupResponse.parse(await confirmCleanup(req.workspaceId, reportId, objectPaths, confirmation)));
  } catch (error) {
    if (!(error instanceof CleanupConflict)) throw error;
    res.status(409).json({ error: error.message });
  }
});
export default router;
