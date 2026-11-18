/** Provider errors retain their status/message; no billing-state interpretation. */
export class OpenAIRequestError extends Error {
  readonly status?: number;
  constructor(error: unknown) {
    const detail = error as { status?: number; message?: string };
    const message = detail?.message ?? String(error);
    const status = detail?.status;
    super(status && !new RegExp(`^${status}\\b`).test(message) ? `${status} ${message}` : message, { cause: error });
    this.name = "OpenAIRequestError";
    this.status = status;
  }
}
