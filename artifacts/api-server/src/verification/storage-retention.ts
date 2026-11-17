/**
 * Explicit development-only storage smoke test. No AI calls or social posts.
 * Uses an isolated synthetic owner, real sidecar-authenticated storage and real
 * database references. Only fixture ages are simulated (GCS creation time is
 * immutable); generation/ACL preconditions and physical deletion remain real.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, pool, projectsTable, generatedClipsTable, autopilotJobsTable,
  aiCheckpointsTable, storageCleanupsTable, sessionsTable, type Clip } from "@workspace/db";
import { eq } from "drizzle-orm";
import { storeBytes, ownedFile } from "../lib/mediaStorage";
import { cleanupServices, storageReport, confirmCleanup } from "../lib/storage-cleanup";
import { inventoryServices, reconcileInventory } from "../lib/storage-index";
import { command } from "../pipeline/process";
import { workspaceRoot } from "../pipeline/paths";
import { createSession } from "../lib/auth";
import { JobContext } from "../pipeline/job-context";
import { buildExport } from "../pipeline/export";

if (process.env.REPLIT_DEPLOYMENT === "1" || !process.argv.includes("--run")) {
  throw new Error("Development-only synthetic test. Pass --run explicitly.");
}
const owner = `user:storage-verification-${randomUUID()}`;
const dir = join(workspaceRoot, "generated-artifacts", `storage-${randomUUID()}`);
const created = new Set<string>();
const expiredFixtures = new Set<string>();
const old = new Date(Date.now() - 40 * 86400000).toISOString();
const services = { ...cleanupServices };
const originalPage = inventoryServices.page;
let projectId: number | undefined;
let session: string | undefined;
async function persist(buffer: Buffer, type: string, expired = false) {
  const path = await storeBytes(buffer, owner, type);
  created.add(path);
  if (expired) expiredFixtures.add(path);
  return path;
}
async function approvedCleanup() {
  await pool.query("UPDATE storage_inventory_state SET advanced_at=NULL");
  do { await reconcileInventory(); }
  while ((await pool.query("SELECT 1 FROM storage_inventory_state WHERE page_token IS NOT NULL")).rowCount);
  const report = await storageReport(owner, { exportDays: 7, intermediateDays: 7 }, true);
  const eligible = report.objects.filter((item) => item.eligible);
  assert.ok(eligible.length > 0);
  assert.ok(eligible.every((item) => expiredFixtures.has(item.objectPath)), "Only explicit isolated fixtures may be deleted");
  return confirmCleanup(owner, report.reportId, eligible.map((item) => item.objectPath), `DELETE ${eligible.length} OBJECTS`);
}
try {
  await mkdir(dir, { recursive: true });
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-threads", "2", "-c:a", "aac", join(dir, "video.mp4")]);
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=2", join(dir, "voice.mp3")]);
  const videoBytes = await readFile(join(dir, "video.mp4")), voiceBytes = await readFile(join(dir, "voice.mp3"));
  const captionsBytes = Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nSynthetic fixture\n");
  const posterBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const source = await persist(videoBytes, "video/mp4");
  const [project] = await db.insert(projectsTable).values({ ownerId: owner, title: "Synthetic storage verification",
    sourceUrl: source, mode: "commentary", status: "completed" }).returning();
  projectId = project!.id;
  const [job] = await db.insert(autopilotJobsTable).values({ ownerId: owner, projectId, requestKey: randomUUID(),
    inputHash: "synthetic-storage", status: "completed", checkpoint: { source: { objectPath: source } } }).returning();
  const aiVoice = await persist(voiceBytes, "audio/mpeg");
  await db.insert(aiCheckpointsTable).values({ jobId: job!.id, callKey: "synthetic-retained-voice", status: "completed", result: { objectPath: aiVoice } });
  const clips: Clip[] = [];
  const expected = new Map<string, Buffer>();
  for (const language of ["en", "es", "pt"]) {
    const video = await persist(videoBytes, "video/mp4"), voice = await persist(voiceBytes, "audio/mpeg"),
      caption = await persist(captionsBytes, "text/plain"), poster = await persist(posterBytes, "image/png");
    for (const [path, data] of [[video, videoBytes], [voice, voiceBytes], [caption, captionsBytes], [poster, posterBytes]] as const) expected.set(path, data);
    const draft = { title: `Synthetic ${language}`, hook: "Storage fixture", script: "Synthetic fixture", hashtags: "#fixture",
      pinnedComment: "Synthetic fixture", captions: true, pictureInPicture: false, campaignId: null };
    const [clip] = await db.insert(generatedClipsTable).values({ ...draft, ownerId: owner, projectId, language,
      originalClipId: clips[0]?.id, creator: "Synthetic fixture", mode: "commentary", duration: 2,
      score: 70, hookScore: 70, visualScore: 70, commentaryScore: 70, objectPath: video,
      voiceoverObjectPath: voice, captionsObjectPath: caption, thumbnail: `/api/storage${poster}`, videoUrl: `/api/storage${video}`,
      renderInfo: { version: 1, snapshot: draft, recipe: { source: { objectPath: source },
        segments: [{ start: 0, end: 2, title: "Synthetic" }], mode: "commentary" } },
    }).returning();
    clips.push(clip!);
  }
  const staleExport = await persist(Buffer.from("Synthetic expired export"), "application/zip", true);
  const orphanVoice = await persist(voiceBytes, "audio/mpeg", true);
  // Only fixture ages are replaced. All ACL, generation and deletion operations use the real provider.
  inventoryServices.page = async (token) => {
    const page = await originalPage(token);
    return { ...page, objects: page.objects.map((item) =>
      item.owner === owner && expiredFixtures.has(item.objectPath) ? { ...item, createdAt: old } : item) };
  };
  cleanupServices.current = async (path) => {
    const item = await services.current(path);
    return item.owner === owner && expiredFixtures.has(path) ? { ...item, createdAt: old } : item;
  };
  const defaults = await storageReport(owner);
  assert.equal(defaults.objects.filter((item) => item.eligible).length, 0);
  const first = await approvedCleanup();
  assert.equal(first.status, "completed");
  assert.ok(first.objects.some((item) => item.objectPath === staleExport && item.outcome === "deleted"));
  assert.ok(first.objects.some((item) => item.objectPath === orphanVoice && item.outcome === "deleted"));
  await assert.rejects(() => ownedFile(staleExport, owner));
  await assert.rejects(() => ownedFile(orphanVoice, owner));
  const pausedSource = await persist(voiceBytes, "audio/mpeg", true);
  const [paused] = await db.insert(autopilotJobsTable).values({ ownerId: owner, projectId, requestKey: randomUUID(),
    inputHash: "synthetic-paused", status: "uncertain", checkpoint: { narration: { objectPath: pausedSource } } }).returning();
  await persist(Buffer.from("Second synthetic expired export"), "application/zip", true);
  const second = await approvedCleanup();
  assert.ok(!second.objects.some((item) => item.objectPath === pausedSource && item.eligible));
  const [processing] = await db.update(autopilotJobsTable).set({ status: "processing", leaseToken: "synthetic-storage-token",
    leaseUntil: new Date(Date.now() + 600000) }).where(eq(autopilotJobsTable.id, paused!.id)).returning();
  const ctx = new JobContext(processing!, "synthetic-storage-token");
  await ctx.save("resumed", { objectPath: pausedSource });
  await db.update(autopilotJobsTable).set({ status: "completed" }).where(eq(autopilotJobsTable.id, paused!.id));
  assert.deepEqual((await (await ownedFile(pausedSource, owner)).download())[0], voiceBytes);
  for (const [path, data] of expected) assert.deepEqual((await (await ownedFile(path, owner)).download())[0], data);
  await assert.rejects(() => ownedFile(clips[0]!.objectPath!, "user:unrelated-storage-fixture"));
  const pack = await buildExport(clips, owner);
  const packPath = pack.downloadUrl.slice("/api/storage".length);
  created.add(packPath);
  const [zip] = await (await ownedFile(packPath, owner)).download();
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  await writeFile(join(dir, "variants.zip"), zip);
  await command("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert len([n for n in z.namelist() if n.endswith('/video.mp4')])==3; assert len([n for n in z.namelist() if n.endswith('/voiceover.mp3')])==3; assert len([n for n in z.namelist() if n.endswith('/captions.srt')])==3", join(dir, "variants.zip")]);
  session = await createSession({ user: { id: owner.slice(5), firstName: "Storage", lastName: "Verification", email: null, profileImageUrl: null },
    access_token: "synthetic-isolated-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  for (const clip of clips) {
    const response = await fetch(`http://localhost:80${clip.videoUrl}`, { headers: { Authorization: `Bearer ${session}`, Range: "bytes=0-63" } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 64);
  }
  const denied = await fetch(`http://localhost:80${clips[0]!.videoUrl}`);
  assert.equal(denied.status, 404);
  await denied.body?.cancel();
  process.stdout.write("PASS: real private storage write/list/read/conditional-delete; defaults keep all; completed EN/ES/PT fixture assets unchanged; 3-language ZIP valid; paused job resumed; owner range playback 206; anonymous and foreign-owner access denied.\nFixture ages simulated; narration is synthetic tone, not newly generated translated speech. No AI or publishing invoked.\n");
} finally {
  Object.assign(cleanupServices, services);
  inventoryServices.page = originalPage;
  // Only paths created by this invocation, and only if still owned by this synthetic owner.
  for (const path of created) {
    try { const file = await ownedFile(path, owner); await file.delete(); } catch (error) {
      if ((error as { code?: number }).code !== 404 && (error as Error).name !== "ObjectNotFoundError") throw error;
    }
  }
  if (projectId) await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
  await db.delete(storageCleanupsTable).where(eq(storageCleanupsTable.ownerId, owner));
  if (session) await db.delete(sessionsTable).where(eq(sessionsTable.sid, session));
  await rm(dir, { recursive: true, force: true });
  await pool.end();
}
