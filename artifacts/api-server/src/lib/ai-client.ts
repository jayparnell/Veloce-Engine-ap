import OpenAI from "openai";
import { aiUsageContext } from "./ai-usage";

export function aiConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const direct = Boolean(env.OPENAI_API_KEY?.trim());
  return { direct, apiKey: direct ? env.OPENAI_API_KEY : env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: direct ? "https://api.openai.com/v1" : env.AI_INTEGRATIONS_OPENAI_BASE_URL };
}
/** One billing route for every production call. Never silently change the payer on failure. */
export function createAIClient(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch) {
  const config = aiConfiguration(env);
  return new OpenAI({ apiKey: config.apiKey || "unconfigured", baseURL: config.baseURL || "https://api.openai.com/v1",
    maxRetries: 0, timeout: 120000,
    fetch: async (url, options) => {
      // OpenAI's upload encoder probes the Response class using a local data: URL.
      if (String(url).startsWith("data:")) return transport(url, options);
      if (!config.apiKey || !config.baseURL) throw new Error("AI is not configured. Add a direct OpenAI key or enable managed AI.");
      const headers = new Headers(options?.headers);
      const invocation = aiUsageContext.getStore();
      if (invocation?.requestKey) {
        headers.set("Idempotency-Key", invocation.requestKey);
        headers.set("X-Client-Request-Id", invocation.requestKey);
      }
      return transport(url, { ...options, headers });
    } });
}
export const openai = createAIClient();
export const scoringModel = () => "gpt-4o-mini" as const;
