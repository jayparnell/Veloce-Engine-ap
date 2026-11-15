/**
 * Explicit development-only API smoke test; creates an isolated account/session
 * fixture directly in the development DB, not an authentication endpoint.
 * Costs Replit AI credits: runs exactly one real media job, with no paid retries.
 */
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const require = createRequire(new URL("../../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
if (!process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DEPLOYMENT === "1") throw new Error("This smoke test is for the development workspace only.");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const directory = fileURLToPath(new URL("../../generated-artifacts/browser-check/", import.meta.url));
const fixture = fileURLToPath(new URL("../../generated-artifacts/fixtures/authorized-source.mp4", import.meta.url));
const sessionFile = "/tmp/veloce-development-test-session.json";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

if (process.argv.includes("--cleanup-session")) {
  const saved = JSON.parse(await readFile(sessionFile, "utf8"));
  await pool.query("DELETE FROM sessions WHERE sid=$1", [saved.cookie.value]);
  await rm(sessionFile, { force: true });
  await pool.end();
  console.log("Removed the isolated development test session.");
  process.exit(0);
}
const userId = `media-smoke-${randomUUID()}`;
const sid = randomBytes(32).toString("hex");
await pool.query("INSERT INTO users (id,first_name,last_name) VALUES ($1,'Media','Smoke')", [userId]);
await pool.query("INSERT INTO sessions (sid,sess,expire) VALUES ($1,$2,$3)", [
  sid, JSON.stringify({ user: { id: userId, email: null, firstName: "Media", lastName: "Smoke", profileImageUrl: null }, access_token: "isolated-development-fixture", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
  new Date(Date.now() + 3600000),
]);
const cookie = { name: "sid", value: sid, domain: new URL(origin).hostname, path: "/", httpOnly: true, secure: true, sameSite: "Lax" };
await writeFile(sessionFile, JSON.stringify({ cookie, origin, userId }), { mode: 0o600 });
await mkdir(directory, { recursive: true });
async function api(path, body, method = "POST") {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { Cookie: `sid=${sid}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function upload(bytes, name, contentType) {
  const reservation = await api("/storage/uploads/request-url", { name, size: bytes.length, contentType });
  const put = await fetch(reservation.uploadURL, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  assert(put.ok, `Signed upload returned ${put.status}`);
  await api("/storage/uploads/finalize", { objectPath: reservation.objectPath });
  return reservation.objectPath;
}
try {
  const auth = await api("/auth/user");
  assert.equal(auth.user.id, userId);
  const summary = await api("/studio/summary");
  assert(summary.capabilities.uploads && summary.capabilities.ai && summary.capabilities.media);
  await api("/settings/integrations/youtube", { clientId: "veloce-test.apps.googleusercontent.com", appApproved: false }, "PUT");
  const settings = await api("/settings/integrations");
  const youtube = settings.find((s) => s.provider === "youtube");
  assert.equal(youtube.clientId, "veloce-test.apps.googleusercontent.com");
  assert.equal(youtube.secretConfigured, false);
  assert.equal(youtube.connected, false);
  assert.equal(youtube.canConnect, false);
  const notReady = await fetch(`${origin}/api/social/oauth/youtube/start`, { headers: { Cookie: `sid=${sid}` }, redirect: "manual" });
  assert.equal(notReady.status, 409);
  const sourcePath = await upload(await readFile(fixture), "authorized-source.mp4", "video/mp4");
  console.log("Verified private source upload and persisted OAuth public configuration.");
  const bedFile = `${directory}/campaign-bed.mp3`;
  const bed = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=110:sample_rate=48000:duration=36", "-b:a", "96k", bedFile], { encoding: "utf8" });
  assert.equal(bed.status, 0, "Could not create synthetic campaign bed");
  const audioPath = await upload(await readFile(bedFile), "campaign-bed.mp3", "audio/mpeg");
  const campaign = await api("/campaigns", { name: "Synthetic media verification", brand: "Veloce test fixture", cpm: 0, budget: 0, status: "active", affiliateUrl: "", cta: "Review your work", audioPath });
  const project = await api("/projects", { sourceUrl: sourcePath, mode: "commentary", clipCount: 1, rightsConfirmed: true, demo: false, campaignId: campaign.id });
  console.log(`Queued real project ${project.id}; one clip with campaign audio.`);
  let current = project;
  let stage = "";
  const deadline = Date.now() + 8 * 60 * 1000;
  while (!["completed", "failed"].includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    current = await api(`/projects/${project.id}`);
    const next = `${current.status}:${current.stage}:${current.progress}`;
    if (next !== stage) { stage = next; console.log(`Project ${project.id}: ${next}`); }
  }
  assert.equal(current.status, "completed", `Pipeline did not complete: ${current.error ?? current.status}`);
  const clips = await api("/clips");
  const clip = clips.find((c) => c.projectId === project.id && !c.demo);
  assert(clip && clip.videoUrl, "Completed job did not create a non-demo video");
  const video = await fetch(`${origin}${clip.videoUrl}`, { headers: { Cookie: `sid=${sid}`, Range: "bytes=0-1023" } });
  assert.equal(video.status, 206);
  assert.match(video.headers.get("Content-Range"), /^bytes 0-1023\/\d+$/);
  assert.equal((await video.arrayBuffer()).byteLength, 1024);
  for (const privatePath of [clip.videoUrl, `/api/storage${sourcePath}`]) {
    const denied = await fetch(`${origin}${privatePath}`);
    assert.equal(denied.status, 404, "An anonymous visitor could read private media");
    await denied.body?.cancel();
  }
  const exported = await api("/exports", { clipIds: [clip.id] });
  assert.equal(exported.includesVideo, true);
  const zip = await fetch(`${origin}${exported.downloadUrl}`, { headers: { Cookie: `sid=${sid}` } });
  assert.equal(zip.status, 200);
  const zipFile = `${directory}/veloce-export.zip`;
  await writeFile(zipFile, Buffer.from(await zip.arrayBuffer()));
  const inspect = spawnSync("python3", ["-c", [
    "import zipfile,json,sys,pathlib",
    "p=pathlib.Path(sys.argv[2])",
    "z=zipfile.ZipFile(sys.argv[1]); names=z.namelist()",
    "required=['video.mp4','voiceover.mp3','captions.srt','captions.txt','metadata.json']",
    "assert all(any(n.endswith('/'+r) for n in names) for r in required),names",
    "copy=z.read(next(n for n in names if n.endswith('/captions.txt'))).decode()",
    "assert all(s in copy for s in ['Title:','Hook:','Hashtags:','Pinned comment:'])",
    "srt=z.read(next(n for n in names if n.endswith('/captions.srt'))).decode()",
    "assert len(srt.split('\\n\\n'))>20",
    "z.extractall(p)",
    "print(json.dumps({'entries':names,'captions':len(srt.split('\\n\\n'))}))",
  ].join(";"), zipFile, directory], { encoding: "utf8" });
  assert.equal(inspect.status, 0, inspect.stderr);
  const outputVideo = `${directory}/clip-${clip.id}/video.mp4`;
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputVideo], { encoding: "utf8" });
  assert.equal(probe.status, 0);
  const info = JSON.parse(probe.stdout);
  const stream = info.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.width, 1080); assert.equal(stream.height, 1920); assert.equal(stream.r_frame_rate, "60/1");
  assert(+info.format.duration >= 30 && +info.format.duration <= 45);
  assert(info.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"));
  const voice = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", `${directory}/clip-${clip.id}/voiceover.mp3`], { encoding: "utf8" });
  assert.equal(JSON.parse(voice.stdout).streams[0].codec_name, "mp3");
  const result = { projectId: project.id, clipId: clip.id, videoUrl: clip.videoUrl, sourcePath, duration: +info.format.duration, width: stream.width, height: stream.height, fps: stream.r_frame_rate, zipFile, outputVideo, checks: JSON.parse(inspect.stdout) };
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log("API smoke test passed. Isolated test session retained temporarily for browser playback checks.");
} finally {
  await pool.end();
}
