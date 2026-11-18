import type { AIUsageMetrics } from "@workspace/db";

export const unknownMetrics = (): AIUsageMetrics => ({
  inputTokens: null, outputTokens: null, totalTokens: null,
  inputAudioTokens: null, outputAudioTokens: null, audioSeconds: null,
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};
function nonnegative(value: unknown, integer = true): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && (!integer || Number.isSafeInteger(value)) ? value : null;
}
/** Preserve only supported numeric usage fields, never prompts, audio bytes or provider payloads. */
export function managedMetrics(response: unknown): AIUsageMetrics {
  const u = record(record(response).usage);
  const input = record(u.prompt_tokens_details ?? u.input_tokens_details ?? u.input_token_details);
  const output = record(u.completion_tokens_details ?? u.output_tokens_details);
  return {
    inputTokens: nonnegative(u.prompt_tokens ?? u.input_tokens),
    outputTokens: nonnegative(u.completion_tokens ?? u.output_tokens),
    totalTokens: nonnegative(u.total_tokens),
    inputAudioTokens: nonnegative(input.audio_tokens),
    outputAudioTokens: nonnegative(output.audio_tokens),
    audioSeconds: nonnegative(u.seconds ?? record(response).duration, false),
  };
}
export function hasMetrics(metrics: AIUsageMetrics) {
  return Object.values(metrics).some((value) => value !== null);
}
/** Null remains unknown. Audio details are subsets, never added to token totals. */
export function addMetrics(a: AIUsageMetrics, b: AIUsageMetrics): AIUsageMetrics {
  const result = unknownMetrics();
  for (const key of Object.keys(result) as (keyof AIUsageMetrics)[]) {
    result[key] = a[key] === null && b[key] === null ? null : (a[key] ?? 0) + (b[key] ?? 0);
  }
  return result;
}
export function usageCategory(language: string, key: string) {
  return language === "es" || language === "pt" ? language
    : key.startsWith("voice:") || key.startsWith("align:") || key === "editor-voice" ? "narration" : "source";
}
