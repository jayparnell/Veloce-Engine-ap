import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { join, dirname } from "node:path";
import { openai, requestOpenAI } from "../lib/ai-client";
import { captureManagedUsage } from "../lib/ai-usage";
import { command } from "./process";
import { mediaPython, mediaRenderer } from "./paths";
import { JobContext } from "./job-context";
import { pool } from "@workspace/db";
import { prepareWhisperAudio } from "./whisper-upload";

export type Word = { start: number; end: number; text: string };
export type WordTranscript = { text: string; words: Word[]; segments: Word[]; provider: string; [key: string]: unknown };
export function wordTranscript(value: unknown, duration: number, provider: string): WordTranscript {
  const raw = (value && typeof value === "object" ? value : {}) as { text?: string; words?: { start: number; end: number; word?: string; text?: string }[]; segments?: Word[] };
  let end = 0;
  const words: Word[] = [];
  for (const word of Array.isArray(raw.words) ? raw.words : []) {
    if (!word || typeof word !== "object") continue;
    const start = Math.max(end, Number(word.start)), stop = Math.min(duration, Number(word.end));
    const text = String(word.word ?? word.text ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !text || start < 0 || stop <= start) continue;
    words.push({ start, end: stop, text }); end = stop;
  }
  if (!words.length) throw Object.assign(new Error("Transcription returned no usable word timestamps."), { status: 422, localFallback: true });
  const segments = words.reduce<Word[]>((all, word, index) => {
    const previous = all.at(-1);
    if (!previous || index % 12 === 0 || word.start - previous.end > .8) all.push({ ...word });
    else { previous.end = word.end; previous.text += ` ${word.text}`; }
    return all;
  }, []);
  return { text: raw.text?.trim() || words.map(w => w.text).join(" "), words, segments, provider };
}
export async function remoteWordTranscript(path: string, duration: number, signal?: AbortSignal, client = openai) {
  const prepared = await prepareWhisperAudio(path);
  try {
  const bytes = await readFile(prepared.path);
  const response = await requestOpenAI(() => client.audio.transcriptions.create({ model: "whisper-1",
    file: new File([bytes], "audio.mp3", { type: "audio/mpeg" }),
    response_format: "verbose_json", timestamp_granularities: ["word"] },
    { maxRetries: 0, timeout: 120000, signal }), signal);
  await captureManagedUsage(response, "whisper-1");
  return wordTranscript(response, duration, "whisper-1");
  } finally { await prepared.cleanup(); }
}
export async function localWordTranscript(path: string, duration: number, ctx?: JobContext) {
  const deadline = Date.now() + 900000;
  for (;;) {
    await ctx?.check();
    const connection = await pool.connect();
    let locked = false;
    try {
      locked = Boolean((await connection.query("SELECT pg_try_advisory_lock(74002,1) AS acquired")).rows[0]?.acquired);
      if (locked) {
        const raw = await command(mediaPython, [join(dirname(mediaRenderer), "transcribe_words.py"), path], 900000);
        await captureManagedUsage({}, "faster-whisper/base:cpu");
        return wordTranscript(JSON.parse(raw), duration, "faster-whisper/base:cpu");
      }
    } finally {
      if (locked) await connection.query("SELECT pg_advisory_unlock(74002,1)").catch(() => {});
      connection.release();
    }
    if (Date.now() > deadline) throw new Error("CPU transcription capacity timed out. Saved work is preserved.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
export async function transcribeWords(path: string, duration: number, ctx?: JobContext, key = "word-transcription",
  services = { remote: remoteWordTranscript, local: localWordTranscript }) {
  const fallbackKey = `asr-local-format:${key}`;
  if (ctx?.job.checkpoint[fallbackKey]) return ctx.ai(`${key}:local`, () => services.local(path, duration, ctx));
  try {
    return ctx ? await ctx.ai(key, () => services.remote(path, duration, ctx.abort.signal))
      : await services.remote(path, duration);
  } catch (error) {
    // A failed OpenAI request must stay visible, never disappear behind CPU fallback.
    // Only a successful response without usable timestamps may use local alignment.
    if (!(error as { localFallback?: boolean })?.localFallback) throw error;
    if (ctx) await ctx.save(fallbackKey, true);
    return ctx ? ctx.ai(`${key}:local`, () => services.local(path, duration, ctx)) : services.local(path, duration);
  }
}
