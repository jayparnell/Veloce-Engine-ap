import { Router, type IRouter } from "express";
import { RequestUploadUrlBody, RequestUploadUrlResponse, FinalizeMediaUploadBody, FinalizeMediaUploadResponse } from "@workspace/api-zod";
import { storage, ownedFile } from "../lib/mediaStorage";
import { setObjectAclPolicy } from "../lib/objectAcl";
import { getCapabilities } from "../lib/capabilities";

const router: IRouter = Router();
router.post("/storage/uploads/request-url", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to upload media." }); return; }
  if (!getCapabilities().uploads) { res.status(503).json({ error: "App Storage is not configured. Uploads are unavailable." }); return; }
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Choose a valid file smaller than 500 MB." }); return; }
  if (!["video/mp4", "video/quicktime", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "image/png", "image/jpeg", "image/webp"].includes(parsed.data.contentType)) {
    res.status(400).json({ error: "Supported files: MP4, MOV, MP3, WAV, PNG, JPEG, WebP." }); return;
  }
  const uploadURL = await storage.getObjectEntityUploadURL();
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  // The ACL metadata is applied after upload by the protected finalize-on-use flow.
  // A reservation ties the unguessable path to the authenticated workspace.
  const { reserveUpload } = await import("../lib/uploads");
  await reserveUpload(objectPath, req.workspaceId, parsed.data.size, parsed.data.contentType);
  res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath }));
});

router.post("/storage/uploads/finalize", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Log in to verify uploads." }); return; }
  const parsed = FinalizeMediaUploadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid uploaded object." }); return; }
  try {
    const { finalizeUpload } = await import("../lib/uploads");
    await finalizeUpload(parsed.data.objectPath, req.workspaceId);
    await ownedFile(parsed.data.objectPath, req.workspaceId);
    res.json(FinalizeMediaUploadResponse.parse(parsed.data));
  } catch { res.status(400).json({ error: "The uploaded file could not be verified. Check its size/type and retry." }); }
});

router.get("/storage/objects/{*objectPath}", async (req, res): Promise<void> => {
  const part = req.params.objectPath;
  const objectPath = `/objects/${Array.isArray(part) ? part.join("/") : part}`;
  try {
    const { finalizeUpload } = await import("../lib/uploads");
    await finalizeUpload(objectPath, req.workspaceId);
    const file = await ownedFile(objectPath, req.workspaceId);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size ?? 0);
    const type = metadata.contentType ?? "application/octet-stream";
    res.set({ "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" });
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) { res.status(416).set("Content-Range", `bytes */${size}`).end(); return; }
      res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      file.createReadStream({ start, end }).on("error", () => res.destroy()).pipe(res);
    } else {
      res.set("Content-Length", String(size));
      if (type === "application/zip") res.set("Content-Disposition", 'attachment; filename="veloce-export.zip"');
      file.createReadStream().on("error", () => res.destroy()).pipe(res);
    }
  } catch { res.status(404).json({ error: "Media not found or access denied." }); }
});
export default router;
