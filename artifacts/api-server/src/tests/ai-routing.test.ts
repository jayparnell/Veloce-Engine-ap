import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { File } from "node:buffer";
import { createAIClient, aiConfiguration } from "../lib/ai-client";
import { aiUsageContext } from "../lib/ai-usage";
import { remoteWordTranscript, transcribeWords, wordTranscript } from "../pipeline/word-transcription";
import { wordSrt, srtTimestamp } from "../pipeline/caption-alignment";
import { requestKey, retryDate } from "../pipeline/ai-retry";

const direct = { OPENAI_API_KEY: "fake-owner-key", AI_INTEGRATIONS_OPENAI_API_KEY: "fake-managed-key", AI_INTEGRATIONS_OPENAI_BASE_URL: "https://managed.invalid/v1" };
const transcript = { text: "Real word timestamps.", words: [
  { word: "Real", start: .123, end: .421 }, { word: "word", start: .481, end: .801 }, { word: "timestamps.", start: 1.117, end: 1.998 },
] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
test("direct key wins, otherwise the existing managed route is retained", () => {
  assert.equal(aiConfiguration(direct).baseURL, "https://api.openai.com/v1");
  assert.equal(aiConfiguration(direct).apiKey, direct.OPENAI_API_KEY);
  const managed = aiConfiguration({ ...direct, OPENAI_API_KEY: "" });
  assert.equal(managed.baseURL, direct.AI_INTEGRATIONS_OPENAI_BASE_URL);
  assert.equal(managed.apiKey, direct.AI_INTEGRATIONS_OPENAI_API_KEY);
});
test("scoring, narration and transcription all use direct routing and stable request headers", async () => {
  const calls: { url: string; body: string; headers: Headers }[] = [];
  const client = createAIClient(direct, async (url, options) => {
    if (String(url).startsWith("data:")) return new Response("");
    calls.push({ url: String(url), body: options?.body ? await new Response(options.body).text() : "", headers: new Headers(options?.headers) });
    return json(String(url).includes("transcriptions") ? transcript : { choices: [{ message: { content: "{}" } }] });
  });
  const key = requestKey("synthetic-owner", 1, "fixture");
  await aiUsageContext.run({ id: -1, responded: false, requestKey: key }, async () => {
    await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "fixture" }] });
    await client.chat.completions.create({ model: "gpt-audio", modalities: ["audio", "text"], audio: { voice: "onyx", format: "mp3" }, messages: [{ role: "user", content: "fixture" }] });
    await client.audio.transcriptions.create({ model: "whisper-1", file: new File(["fake-audio"], "fixture.mp3"),
      response_format: "verbose_json", timestamp_granularities: ["word"] });
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.url.startsWith("https://api.openai.com/v1/"));
    assert.equal(call.headers.get("authorization"), "Bearer fake-owner-key");
    assert.equal(call.headers.get("idempotency-key"), key);
  }
  assert.match(calls[2]!.body, /name="response_format"\r\n\r\nverbose_json/);
  assert.match(calls[2]!.body, /name="timestamp_granularities\[\]"\r\n\r\nword/);
});
test("401 and 429 are not silently rerouted or retried by the SDK", async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const client = createAIClient(direct, async url => { calls++; assert.ok(String(url).startsWith("https://api.openai.com/")); return json({ error: { message: "fixture rejection" } }, status); });
    await assert.rejects(client.chat.completions.create({ model: "gpt-4o-mini", messages: [] }), e => (e as { status: number }).status === status);
    assert.equal(calls, 1);
  }
});
test("Whisper's actual word milliseconds survive normalization and SRT generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asr-"));
  try {
    const file = join(dir, "voice.mp3"); await writeFile(file, "synthetic-audio");
    const client = createAIClient(direct, async () => json(transcript));
    const result = await remoteWordTranscript(file, 3, undefined, client);
    assert.equal(result.words[0]!.start, .123);
    assert.match(wordSrt(result.words), /00:00:01,117 --> 00:00:01,998/);
    assert.equal(srtTimestamp(59.9999), "00:01:00,000");
    assert.throws(() => wordTranscript({ text: "No timestamps" }, 2, "fixture"), /word timestamps/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("CPU fallback is explicit; authentication failures are not hidden", async () => {
  let local = 0;
  const services = { remote: async () => { throw Object.assign(new Error("unsupported"), { status: 404 }); },
    local: async () => { local++; return wordTranscript(transcript, 3, "local-fixture"); } };
  assert.equal((await transcribeWords("synthetic", 3, undefined, "fixture", services)).provider, "local-fixture");
  await assert.rejects(transcribeWords("synthetic", 3, undefined, "fixture", { ...services, remote: async () => { throw Object.assign(new Error("denied"), { status: 401 }); } }));
  assert.equal(local, 1);
});
test("retry backoff doubles and never precedes provider Retry-After", () => {
  assert.deepEqual([1, 2, 3].map(n => retryDate(n, undefined, 0).getTime()), [2000, 4000, 8000]);
  assert.equal(retryDate(1, new Headers({ "retry-after": "90" }), 0).getTime(), 90000);
  assert.equal(requestKey("owner", 2, "voice"), requestKey("owner", 2, "voice"));
  assert.notEqual(requestKey("other-owner", 2, "voice"), requestKey("owner", 2, "voice"));
});
