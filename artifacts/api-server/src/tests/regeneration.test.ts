import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import express from "express";
import { db, pool, projectsTable as projects, generatedClipsTable as clips, autopilotJobsTable as jobs, type PoolClient } from "@workspace/db";
import { eq } from "drizzle-orm";
import studio from "../routes/studio";
import { snapshot, outdated, publicClip } from "../pipeline/render-state";
import { runRegeneration } from "../pipeline/regenerate";
import { JobContext } from "../pipeline/job-context";
import { reserveOutputs } from "../lib/render-budget";
import { command } from "../pipeline/process";
import { workspaceRoot, mediaPython, mediaRenderer } from "../pipeline/paths";
import { buildExport } from "../pipeline/export";
import type { ownedFile } from "../lib/mediaStorage";
import { Readable } from "node:stream";
import { RegenerateClipResponse, UpdateClipResponse } from "@workspace/api-zod";

const schema = `editor_${randomUUID().replaceAll("-", "")}`;
const dir = join(workspaceRoot, "generated-artifacts", schema);
let base: string;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.workspaceId = req.headers["x-owner"] as string || "fixture";
  req.isAuthenticated = (() => req.headers["x-auth"] !== "no") as typeof req.isAuthenticated;
  next();
});
app.use(studio);
const server = createServer(app);
before(async () => {
  await mkdir(dir, { recursive: true });
  const c = await pool.connect();
  await c.query(`CREATE SCHEMA "${schema}"`);
  (pool.options as { onConnect?: (c: PoolClient) => Promise<unknown> }).onConnect = (client) => client.query(`SET search_path TO "${schema}"`);
  try {
    await c.query(`SET search_path TO "${schema}"`);
    for (const table of ["projects", "generated_clips", "monetization_campaigns", "social_configs"]) {
      await c.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      if (table !== "social_configs") {
        await c.query(`CREATE SEQUENCE ${table}_fixture_id`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_fixture_id')`);
      }
    }
    for (const migration of ["20261116_autopilot.sql", "20261116_render_guardrails.sql", "20261116_editor_regeneration.sql", "20261116_ai_usage.sql", "20261117_unified_posting.sql"]) {
      await c.query(await readFile(join(workspaceRoot, "lib/db/migrations", migration), "utf8"));
    }
  } finally { c.release(); }
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=400:duration=2", "-shortest", "-c:v", "libx264", "-threads", "2", "-c:a", "aac", join(dir, "source.mp4")]);
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=700:duration=1.8", join(dir, "voice.mp3")]);
  await writeFile(join(dir, "original.srt"), "1\n00:00:00,100 --> 00:00:00,900\nOriginal\n\n2\n00:00:00,900 --> 00:00:01,700\nnarration\n");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const ownerId = randomUUID();
  const [p] = await db.insert(projects).values({ ownerId, title: "Fixture", sourceUrl: "/objects/source", mode: "commentary", status: "completed" }).returning();
  const draft = { title: "Original title", hook: "Original hook", script: "Original narration", hashtags: "#Original", pinnedComment: "Original comment", captions: true, pictureInPicture: true, campaignId: null };
  const [clip] = await db.insert(clips).values({ ...draft, projectId: p!.id, ownerId, mode: "commentary", duration: 2,
    creator: "Fixture", score: 70, hookScore: 70, visualScore: 70, commentaryScore: 70,
    objectPath: "/objects/old-video", videoUrl: "/api/storage/objects/old-video", voiceoverObjectPath: "/objects/old-voice", captionsObjectPath: "/objects/old-captions",
    renderInfo: { version: 1, snapshot: draft, recipe: { source: { objectPath: "/objects/source" }, segments: [{ start: 0, end: 2, title: "Fixture" }], mode: "commentary" } },
  }).returning();
  return clip!;
}
async function request(clip: Awaited<ReturnType<typeof fixture>>, action: string, data?: unknown, owner = clip.ownerId) {
  return fetch(`${base}/clips/${clip.id}${action}`, { method: data ? "PATCH" : "POST", headers: { "content-type": "application/json", "x-owner": owner }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
async function start(clip: Awaited<ReturnType<typeof fixture>>) {
  const response = await request(clip, "/regenerate");
  assert.equal(response.status, 202, await response.clone().text());
  const result = RegenerateClipResponse.parse(await response.json());
  assert.ok(result.regenerationJobId);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, result.regenerationJobId));
  const token = randomUUID();
  const [processing] = await db.update(jobs).set({ status: "processing", leaseToken: token }).where(eq(jobs.id, job!.id)).returning();
  await reserveOutputs(clip.ownerId, job!.id, 1, token);
  return new JobContext(processing!, token);
}
const bytes = new Map<string, Buffer>();
let synthesized = 0;
const services = {
  download: async (path: string, destination: string, _owner: string) => {
    const name = path === "/objects/source" ? "source.mp4" : path === "/objects/old-voice" ? "voice.mp3" : path === "/objects/old-captions" ? "original.srt" : null;
    if (name) await copyFile(join(dir, name), destination);
    else { assert.ok(bytes.has(path)); await writeFile(destination, bytes.get(path)!); }
  },
  persist: async (path: string, _owner: string, _type: string) => {
    const key = `/objects/${randomUUID()}`; bytes.set(key, await readFile(path)); return key;
  },
  synthesize: async (script: string) => { synthesized++; return { bytes: await readFile(join(dir, "voice.mp3")), transcript: script }; },
  render: async (path: string) => { await command(mediaPython, [mediaRenderer, "render", path], 900000); },
};

test("save is metadata-only, regeneration is owner-scoped, explicit and single-flight", async () => {
  const clip = await fixture();
  assert.equal((await request(clip, "/regenerate", undefined, "someone-else")).status, 404);
  assert.equal((await fetch(`${base}/clips/${clip.id}/regenerate`, { method: "POST", headers: { "x-auth": "no" } })).status, 401);
  assert.equal((await request(clip, "/regenerate")).status, 409);
  const saved = await request(clip, "", { hook: "Edited hook", captions: false, pictureInPicture: false });
  assert.equal(saved.status, 200);
  const edited = UpdateClipResponse.parse(await saved.json());
  assert.equal(edited.videoUrl, clip.videoUrl);
  assert.equal(edited.renderVersion, 1);
  assert.equal(edited.renderOutdated, true);
  const accepted = await Promise.all([request(clip, "/regenerate"), request(clip, "/regenerate")]);
  assert.deepEqual(accepted.map((r) => r.status).sort(), [202, 409]);
});

test("real replacement reuses narration and exact captions, preserves newer saved edits and exports a matching set", async () => {
  const clip = await fixture();
  await request(clip, "", { hook: "New hook", captions: false, pictureInPicture: false, title: "Rendered title" });
  const ctx = await start(clip);
  await request(clip, "", { hook: "Newer unsent hook", title: "Next draft" });
  const connection = await pool.connect();
  const before = synthesized;
  try { await runRegeneration(ctx, connection, services); } finally { connection.release(); }
  assert.equal(synthesized, before);
  const [ready] = await db.select().from(clips).where(eq(clips.id, clip.id));
  assert.notEqual(ready!.objectPath, clip.objectPath);
  assert.equal(ready!.renderInfo!.version, 2);
  assert.equal(ready!.renderInfo!.snapshot.hook, "New hook");
  assert.equal(ready!.hook, "Newer unsent hook");
  assert.equal(outdated(ready!), true);
  assert.equal(bytes.get(ready!.captionsObjectPath!)!.toString(), await readFile(join(dir, "original.srt"), "utf8"));
  const video = join(dir, "verified.mp4"); await writeFile(video, bytes.get(ready!.objectPath!)!);
  const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_streams", "-of", "json", video]));
  assert.equal(probe.streams[0].width, 1080);
  assert.equal(probe.streams[0].height, 1920);
  assert.equal(probe.streams[0].r_frame_rate, "60/1");
  let zip!: Buffer;
  await buildExport([ready!], clip.ownerId, {
    ownedFile: (async (path: string) => ({ createReadStream: () => Readable.from(bytes.get(path)!) })) as unknown as typeof ownedFile,
    storeBytes: async (buffer) => { zip = buffer; return "/objects/export"; },
  });
  const zipPath = join(dir, "export.zip"); await writeFile(zipPath, zip);
  const contents = JSON.parse(await command(mediaPython, ["-c", "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); p=sys.argv[2]; print(json.dumps({'names':z.namelist(),'metadata':json.loads(z.read(p+'/metadata.json')),'draft':json.loads(z.read(p+'/saved-edits.json'))}))", zipPath, `clip-${clip.id}`]));
  assert.equal(contents.metadata.hook, "New hook");
  assert.equal(contents.metadata.title, "Rendered title");
  assert.equal(contents.metadata.captions, false);
  assert.equal(contents.metadata.renderVersion, 2);
  assert.equal(contents.draft.hook, "Newer unsent hook");
  for (const name of ["video.mp4", "voiceover.mp3", "captions.srt", "metadata.json"]) assert.ok(contents.names.includes(`clip-${clip.id}/${name}`));
});

test("changed narration is checkpointed once; upload failure keeps old media, retry replaces all assets", async () => {
  const clip = await fixture();
  await request(clip, "", { script: "Changed narration with matching captions" });
  const ctx = await start(clip);
  const connection = await pool.connect();
  const before = synthesized;
  try {
    await assert.rejects(runRegeneration(ctx, connection, { ...services, persist: async (path, owner, type) => {
      if (type === "video/mp4") throw new Error("Fixture storage failure");
      return services.persist(path, owner, type);
    } }), /storage failure/);
    const [failed] = await db.select().from(clips).where(eq(clips.id, clip.id));
    assert.equal(failed!.objectPath, clip.objectPath);
    assert.equal(failed!.voiceoverObjectPath, clip.voiceoverObjectPath);
    assert.equal(failed!.captionsObjectPath, clip.captionsObjectPath);
    assert.equal(failed!.renderInfo!.version, 1);
    await runRegeneration(ctx, connection, services);
    assert.equal(synthesized, before + 1);
    const [ready] = await db.select().from(clips).where(eq(clips.id, clip.id));
    assert.equal(ready!.renderInfo!.snapshot.script, "Changed narration with matching captions");
    const captions = bytes.get(ready!.captionsObjectPath!)!.toString();
    for (const word of ["Changed", "narration", "matching", "captions"]) assert.ok(captions.includes(word));
    assert.equal((await publicClip(ready!)).renderVersion, 2);
  } finally { connection.release(); }
});

test("historical clips without retained source inputs are explicitly unsupported, never erased", async () => {
  const clip = await fixture();
  await db.update(clips).set({ renderInfo: null, jobId: null }).where(eq(clips.id, clip.id));
  assert.equal((await request(clip, "/regenerate")).status, 409);
  const [kept] = await db.select().from(clips).where(eq(clips.id, clip.id));
  assert.equal(kept!.objectPath, clip.objectPath);
  assert.equal((await publicClip(kept!)).canRegenerate, false);
  assert.equal(snapshot(kept!).hook, clip.hook);
});

test("story title edits match the chapter actually burned into the replacement and exported copy", async () => {
  const clip = await fixture();
  const storyInfo = { ...clip.renderInfo!, recipe: { ...clip.renderInfo!.recipe, mode: "story" } };
  await db.update(clips).set({ mode: "story", renderInfo: storyInfo }).where(eq(clips.id, clip.id));
  await request(clip, "", { title: "Updated story headline" });
  const ctx = await start(clip);
  let chapter = "";
  const c = await pool.connect();
  try {
    await runRegeneration(ctx, c, { ...services, render: async (path) => {
      await services.render(path);
      const ass = await readFile(path.replace(/\.json$/, ".ass"), "utf8");
      chapter = ass.split("\n").find((line) => line.startsWith("Dialogue:") && line.includes(",Chapter,,")) ?? "";
      assert.ok(chapter.includes("01 / Updated story headline"));
      assert.ok(!chapter.includes("Original title"));
    } });
  } finally { c.release(); }
  const [ready] = await db.select().from(clips).where(eq(clips.id, clip.id));
  assert.equal(ready!.renderInfo!.recipe.segments[0]!.title, "Updated story headline");
  let zip!: Buffer;
  await buildExport([ready!], clip.ownerId, {
    ownedFile: (async (path: string) => ({ createReadStream: () => Readable.from(bytes.get(path)!) })) as unknown as typeof ownedFile,
    storeBytes: async (buffer) => { zip = buffer; return "/objects/story-export"; },
  });
  const path = join(dir, "story-export.zip"); await writeFile(path, zip);
  const exported = JSON.parse(await command(mediaPython, ["-c", "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); p=sys.argv[2]; print(json.dumps({'metadata':json.loads(z.read(p+'/metadata.json')),'copy':z.read(p+'/copy.txt').decode()}))", path, `clip-${clip.id}`]));
  assert.ok(chapter.includes(exported.metadata.title));
  assert.ok(exported.copy.includes(`Title: ${exported.metadata.title}`));
});
