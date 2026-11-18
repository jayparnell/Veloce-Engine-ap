import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAIClient, aiConfiguration, requestOpenAI, OpenAIRequestError } from "../lib/ai-client";
import { remoteWordTranscript, transcribeWords, wordTranscript } from "../pipeline/word-transcription";
import { wordSrt, srtTimestamp } from "../pipeline/caption-alignment";
import { command } from "../pipeline/process";
import { prepareWhisperAudio, assertWhisperSize, MAX_WHISPER_BYTES } from "../pipeline/whisper-upload";
import { redactError } from "../lib/failure-policy";

const direct = { OPENAI_API_KEY: "fake-owner-key", AI_INTEGRATIONS_OPENAI_API_KEY: "fake-managed-key", AI_INTEGRATIONS_OPENAI_BASE_URL: "https://managed.invalid/v1" };
const transcript = { text: "Real word timestamps.", words: [
  { word: "Real", start: .123, end: .421 }, { word: "word", start: .481, end: .801 }, { word: "timestamps.", start: 1.117, end: 1.998 },
] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
test("routing is direct-only, including when managed credentials exist without a direct key", () => {
  assert.equal(aiConfiguration(direct).baseURL, "https://api.openai.com/v1");
  assert.equal(aiConfiguration(direct).apiKey, direct.OPENAI_API_KEY);
  assert.equal(aiConfiguration({ ...direct, OPENAI_API_KEY: "" }).apiKey, "");
});
test("missing direct key is explicit and makes no upstream request", async () => {
  let calls = 0;
  const client = createAIClient({ ...direct, OPENAI_API_KEY: "" }, async () => { calls++; return json({}); });
  await assert.rejects(requestOpenAI(() => client.chat.completions.create({ model: "gpt-4o-mini", messages: [] }), undefined,
    async () => assert.fail("configuration errors must not wait")), /OPENAI_API_KEY is not configured/);
  assert.equal(calls, 0);
});
test("chat and audio use the direct endpoint and SDK retries are disabled", async () => {
  const calls: string[] = [];
  const client = createAIClient(direct, async (url, options) => {
    calls.push(String(url));
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fake-owner-key");
    return json({ choices: [{ message: { content: "{}" } }] });
  });
  for (const model of ["gpt-4o-mini", "gpt-audio"]) await requestOpenAI(() => client.chat.completions.create({ model, messages: [] }));
  assert.deepEqual(calls, ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions"]);
  assert.equal(client.maxRetries, 0);
});
test("400, 401, 429 and 500 preserve the final provider diagnostic with exactly two 3-second retries", async () => {
  for (const [status, message] of [[400, "Invalid parameter"], [401, "Incorrect API key"], [429, "Insufficient quota"], [500, "Internal server error"]] as const) {
    let calls = 0; const delays: number[] = [];
    const client = createAIClient(direct, async () => { calls++; return json({ error: { message } }, status); });
    await assert.rejects(requestOpenAI(() => client.chat.completions.create({ model: "gpt-4o-mini", messages: [] }), undefined,
      async ms => { delays.push(ms); }), e => e instanceof OpenAIRequestError && e.status === status && e.message === `${status} ${message}`);
    assert.equal(calls, 3); assert.deepEqual(delays, [3000, 3000]);
  }
});
test("network errors preserve their diagnostic, successful retries stop, and cancellation prevents further calls", async () => {
  let calls = 0;
  assert.equal(await requestOpenAI(async () => { if (++calls < 3) throw new Error("socket reset"); return "ok"; }, undefined, async () => {}), "ok");
  const controller = new AbortController(); calls = 0;
  await assert.rejects(requestOpenAI(async () => { calls++; throw new Error("socket reset"); }, controller.signal, async () => controller.abort()));
  assert.equal(calls, 1);
  await assert.rejects(requestOpenAI(async () => { throw new Error("ECONNRESET fixture"); }, undefined, async () => {}), /ECONNRESET fixture/);
});
test("provider messages retain URLs and parameters while credentials are removed", () => {
  const message = "400 Invalid parameter response_format. See https://platform.openai.com/docs/guides/speech-to-text";
  assert.equal(redactError(new OpenAIRequestError(Object.assign(new Error(message), { status: 400 }))), message);
  assert.doesNotMatch(redactError(new OpenAIRequestError(new Error("401 Incorrect API key sk-fixtureSecret"))), /sk-fixtureSecret/);
});
test("real stereo PCM becomes mono 64kbps MP3 before Whisper multipart upload; word timing survives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whisper-test-"));
  try {
    const input = join(dir, "stereo.wav");
    await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", input], 15000);
    const prepared = await prepareWhisperAudio(input);
    const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_streams", "-of", "json", prepared.path], 15000));
    assert.equal(probe.streams[0].channels, 1); assert.equal(Number(probe.streams[0].bit_rate), 64000);
    assert.ok((await readFile(prepared.path)).length < MAX_WHISPER_BYTES);
    await prepared.cleanup();
    let uploads = 0;
    const client = createAIClient(direct, async (url, options) => {
      if (String(url).startsWith("data:")) return new Response("");
      uploads++; assert.equal(String(url), "https://api.openai.com/v1/audio/transcriptions");
      const body = await new Response(options?.body).text();
      assert.match(body, /name="response_format"\r\n\r\nverbose_json/);
      assert.match(body, /name="timestamp_granularities\[\]"\r\n\r\nword/);
      assert.match(body, /filename="audio.mp3"/);
      return json(transcript);
    });
    const result = await remoteWordTranscript(input, 3, undefined, client);
    assert.equal(uploads, 1); assert.equal(result.words[0]!.start, .123);
    assert.match(wordSrt(result.words), /00:00:01,117 --> 00:00:01,998/);
    assert.equal(srtTimestamp(59.9999), "00:01:00,000");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("empty and oversized Whisper files are rejected before upload", () => {
  assert.throws(() => assertWhisperSize(0), /empty/);
  assert.throws(() => assertWhisperSize(MAX_WHISPER_BYTES), /exceeds/);
  assert.throws(() => assertWhisperSize(25_000_000), /exceeds/);
  assert.doesNotThrow(() => assertWhisperSize(MAX_WHISPER_BYTES - 1));
});
test("CPU alignment never hides OpenAI errors, including quota and invalid parameters", async () => {
  let local = 0;
  for (const status of [400, 401, 404, 429, 500]) {
    const failure = new OpenAIRequestError(Object.assign(new Error("provider fixture"), { status }));
    await assert.rejects(transcribeWords("synthetic", 3, undefined, "fixture", {
      remote: async () => { throw failure; },
      local: async () => { local++; return wordTranscript(transcript, 3, "local"); },
    }), error => error === failure);
  }
  assert.equal(local, 0);
});
