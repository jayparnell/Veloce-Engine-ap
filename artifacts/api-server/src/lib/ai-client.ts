import OpenAI from "openai";
import { setTimeout as sleep } from "node:timers/promises";
import { OpenAIRequestError } from "./openai-error";
export { OpenAIRequestError } from "./openai-error";

export function aiConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return { direct: true, apiKey: env.OPENAI_API_KEY?.trim(), baseURL: "https://api.openai.com/v1" };
}
/** One billing route for every production call. Never silently change the payer on failure. */
export function createAIClient(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch) {
  const config = aiConfiguration(env);
  return new OpenAI({ apiKey: config.apiKey || "unconfigured", baseURL: config.baseURL || "https://api.openai.com/v1",
    maxRetries: 0, timeout: 120000,
    fetch: async (url, options) => {
      // OpenAI's upload encoder probes the Response class using a local data: URL.
      if (String(url).startsWith("data:")) return transport(url, options);
      if (!config.apiKey) throw new OpenAIRequestError(new Error("OPENAI_API_KEY is not configured."));
      return transport(url, options);
    } });
}
export const openai = createAIClient();
export const scoringModel = () => "gpt-4o-mini" as const;

/** Recreate the request (including multipart bodies) on each of two retries. */
export async function requestOpenAI<T>(call: () => PromiseLike<T>, signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<unknown> = (ms, s) => sleep(ms, undefined, { signal: s })) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await call(); }
    catch (error) {
      if (signal?.aborted) throw error;
      if ((error as { cause?: unknown })?.cause instanceof OpenAIRequestError) throw (error as { cause: OpenAIRequestError }).cause;
      if (attempt === 2 || error instanceof OpenAIRequestError) throw error instanceof OpenAIRequestError ? error : new OpenAIRequestError(error);
      await wait(3000, signal);
    }
  }
}
