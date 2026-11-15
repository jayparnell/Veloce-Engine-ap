import { openai } from "@workspace/integrations-openai-ai-server";
import { speechToText } from "@workspace/integrations-openai-ai-server/audio";
import { batchProcess } from "@workspace/integrations-openai-ai-server/batch";
import { readFile } from "node:fs/promises";

export async function transcribeSource(chunks: { path: string; start: number; end: number }[]) {
  return batchProcess(chunks, async (chunk) => {
    const text = await speechToText(await readFile(chunk.path), "mp3");
    return { start: chunk.start, end: chunk.end, text: text.trim() };
  }, { concurrency: 2, retries: 3, maxTimeout: 15000 });
}

/** Managed chat/audio endpoint only: no external speech API or user API key. */
export async function synthesizeVoiceover(script: string) {
  const [result] = await batchProcess([script], async (text) => {
    const response = await openai.chat.completions.create({
      model: "gpt-audio",
      modalities: ["text", "audio"],
      audio: { voice: "onyx", format: "mp3" },
      messages: [
        { role: "system", content: "Read the supplied narration verbatim in a clear analytical voice. Do not add any introduction, explanation or extra words." },
        { role: "user", content: text },
      ],
    }, { timeout: 120000 });
    const audio = response.choices[0]?.message.audio;
    if (!audio?.data) throw new Error("Voiceover synthesis returned no audio. Retry this batch.");
    const bytes = Buffer.from(audio.data, "base64");
    if (bytes.length < 1000) throw new Error("Voiceover synthesis returned an empty MP3. Retry this batch.");
    return { bytes, transcript: audio.transcript?.trim() || text };
  }, { concurrency: 1, retries: 3, maxTimeout: 15000 });
  return result!;
}
