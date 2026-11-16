import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { db, pool, mediaUploadsTable, autopilotJobsTable, generatedClipsTable, sessionsTable, projectsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { synthesizeVoiceover } from "../pipeline/audio";
import { command } from "../pipeline/process";
import { storeLocalFile, ownedFile } from "../lib/mediaStorage";
import { createSession } from "../lib/auth";

const root = resolve(process.cwd(), "../.."), dir = join(root, "generated-artifacts/verification");
await mkdir(dir, { recursive: true });
const resumeId = Number(process.argv[2]) || null;
const [resumeJob] = resumeId ? await db.select().from(autopilotJobsTable).where(eq(autopilotJobsTable.id, resumeId)) : [];
if (resumeId && !resumeJob?.ownerId.startsWith("user:media-verification-")) throw new Error("Only isolated media-verification jobs may be resumed.");
const userId = resumeJob ? resumeJob.ownerId.slice(5) : `media-verification-${randomUUID()}`, owner = `user:${userId}`;
const session = await createSession({ user: { id: userId, firstName: "Media", lastName: "Verification", email: null, profileImageUrl: null }, access_token: "synthetic-isolated-session" });
const headers = { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
async function api(path: string, body?: unknown) {
  const response = await fetch(`http://localhost:80/api${path}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Verification request failed ${response.status}: ${data.error ?? path}`);
  return data;
}
async function wait(ids: number[]) {
  const deadline = Date.now() + 20 * 60000;
  while (Date.now() < deadline) {
    const jobs = await db.select().from(autopilotJobsTable).where(inArray(autopilotJobsTable.id, ids));
    if (jobs.some((j) => ["failed", "uncertain", "cancelled"].includes(j.status))) throw new Error(`Fixture processing stopped: ${jobs.map((j) => `${j.status}: ${j.error}`).join("; ")}`);
    if (jobs.every((j) => j.status === "completed")) return jobs;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Fixture media verification exceeded 20 minutes.");
}
try {
  let objectPath: string, receipt: { jobIds: number[] };
  if (resumeJob) {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, resumeJob.projectId));
    objectPath = project!.sourceUrl;
    if (["failed", "uncertain", "cancelled"].includes(resumeJob.status)) await api(`/autopilot/jobs/${resumeJob.id}/action`, { action: resumeJob.status === "uncertain" ? "acknowledge-uncertain" : "retry" });
    receipt = { jobIds: [resumeJob.id] };
    process.stdout.write("Resuming isolated fixture using completed transcription and storage checkpoints; acknowledged unfinished test AI call.\n");
  } else {
  process.stdout.write("Generating an original authorized synthetic-source narration through managed gpt-audio.\n");
  const voice = await synthesizeVoiceover("A useful way to judge a new editing tool is to separate what it measures from what it promises. A high score can help organize a review, but it cannot predict an audience. Check the evidence, listen to the explanation, and inspect the final video. Faster production is valuable only when the result remains accurate. Creators still need permission to use their source footage and music, and each social account has its own publishing requirements. Automation should make these decisions visible rather than hide them.");
  const voicePath = join(dir, "authorized-source-voice.mp3"); await writeFile(voicePath, voice.bytes);
  const sourcePath = join(dir, "authorized-source.mp4");
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=45", "-i", voicePath,
    "-filter_complex", "[1:a]apad[a]", "-map", "0:v", "-map", "[a]", "-t", "45", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath]);
  objectPath = await storeLocalFile(sourcePath, owner, "video/mp4");
  const file = await ownedFile(objectPath, owner), [metadata] = await file.getMetadata();
  await db.insert(mediaUploadsTable).values({ objectPath, ownerId: owner, contentType: "video/mp4", size: Number(metadata.size), finalized: true });
  receipt = await api("/autopilot/launch", { sources: [objectPath], idempotencyKey: randomUUID() });
  }
  process.stdout.write("Accepted source; waiting for real transcription, analysis, narration and verified renders.\n");
  const sourceJobs = await wait(receipt.jobIds);
  const originals = await db.select().from(generatedClipsTable).where(inArray(generatedClipsTable.jobId, receipt.jobIds));
  if (originals.length < 3) throw new Error("Expected at least three playable original clips.");
  const original = originals[0]!;
  const dub = await api("/autopilot/dub", { clipIds: [original.id] });
  const replay = await api("/autopilot/dub", { clipIds: [original.id] });
  if (JSON.stringify([...dub.jobIds].sort()) !== JSON.stringify([...replay.jobIds].sort())) throw new Error("Dub replay duplicated jobs.");
  process.stdout.write("Original clips ready. Waiting for real Spanish and Portuguese variants.\n");
  await wait(dub.jobIds);
  const variants = await db.select().from(generatedClipsTable).where(inArray(generatedClipsTable.jobId, dub.jobIds));
  if (!variants.some((c) => c.language === "es") || !variants.some((c) => c.language === "pt")) throw new Error("Both language variants must be persisted.");
  const pack = await api("/exports", { clipIds: [original.id, ...variants.map((c) => c.id)] });
  const download = await fetch(`http://localhost:80${pack.downloadUrl}`, { headers });
  if (!download.ok) throw new Error("Owner ZIP download failed.");
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.subarray(0, 2).toString() !== "PK") throw new Error("Export is not a ZIP.");
  const guest = await fetch(`http://localhost:80${pack.downloadUrl}`);
  if (![401, 403, 404].includes(guest.status)) throw new Error("Private ZIP was accessible without owner authorization.");
  const playback = await fetch(`http://localhost:80${original.videoUrl}`, { headers: { ...headers, Range: "bytes=0-2047" } });
  if (playback.status !== 206) throw new Error("Private seekable playback must support HTTP 206.");
  const report = { userId, owner, sourceObjectPath: objectPath, projectId: original.projectId,
    originalClipIds: originals.map((c) => c.id), variantClipIds: variants.map((c) => ({ id: c.id, language: c.language })),
    jobIds: [...receipt.jobIds, ...dub.jobIds], analysisMs: sourceJobs[0]!.checkpoint.analysisMs, transcriptKind: sourceJobs[0]!.checkpoint.transcriptKind,
    verified: ["managed source narration", "local owner-scoped storage", "bounded fallback transcription", "grounded 3+ moment planning", "1080x1920/60fps renders", "incremental private playable clips", "real ES/PT commentary + narration + renders", "dub request deduplication", "MP4/voice/SRT/metadata ZIP", "owner range playback", "anonymous ZIP denied"],
    limits: "Synthetic authorized source, not provider VOD or human face footage. Provider publishing remains mocked; no social post was sent. Caption word boundaries are estimated and require review. Analysis includes provider latency and is not guaranteed under 3s." };
  await writeFile(join(dir, "media-verification.json"), JSON.stringify(report, null, 2));
  await writeFile(join(dir, "ready-to-post-verification.zip"), bytes);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, session));
  await pool.end();
}
