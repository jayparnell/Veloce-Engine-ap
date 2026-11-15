/**
 * Explicit paid smoke-test fixture generation. Never invoked by app startup.
 * Uses the same managed gpt-audio model as production, on Replit credits.
 */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../lib/integrations-openai-ai-server/package.json", import.meta.url));
const OpenAI = require("openai").default;
const directory = fileURLToPath(new URL("../../generated-artifacts/fixtures/", import.meta.url));
await mkdir(directory, { recursive: true });
const client = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});
const narration = "This is an original synthetic editing workshop. Good decisions start with a clear goal. First, identify the one idea your audience should remember. Then remove anything that distracts from that idea. A short explanation can be more useful than a long collection of disconnected highlights. Notice how a pause gives the listener time to think. Finally, compare your finished result with the goal you chose at the beginning. Clear reasoning matters more than adding effects.";
const response = await client.chat.completions.create({
  model: "gpt-audio", modalities: ["text", "audio"], audio: { voice: "onyx", format: "mp3" },
  messages: [{ role: "system", content: "Read the narration verbatim, without introductions, in a clear voice." }, { role: "user", content: narration }],
}, { timeout: 120000 });
const audio = response.choices[0]?.message.audio;
if (!audio?.data) throw new Error("Managed audio did not return MP3 bytes");
await writeFile(`${directory}/source-voice.mp3`, Buffer.from(audio.data, "base64"));
const result = spawnSync("ffmpeg", [
  "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x102020:s=1280x720:r=30:d=34",
  "-i", `${directory}/source-voice.mp3`,
  "-vf", "drawgrid=w=80:h=80:t=2:c=0x285544,drawtext=text='VELOCE SYNTHETIC WORKSHOP':fontsize=42:fontcolor=white:x='40+20*sin(t*2)':y=150,drawtext=text='Clear reasoning beats disconnected highlights':fontsize=28:fontcolor=0x80ddaa:x=40:y=300",
  "-af", "apad", "-t", "34", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2",
  "-crf", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
  `${directory}/authorized-source.mp4`,
], { encoding: "utf8" });
if (result.status !== 0) throw new Error(`Fixture encoding failed: ${result.stderr}`);
console.log("Created generated-artifacts/fixtures/authorized-source.mp4 (34 seconds, synthetic authorized source).");
