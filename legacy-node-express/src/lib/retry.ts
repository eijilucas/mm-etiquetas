import { logger } from "./logger";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
  isRetryable?: (error: unknown) => boolean;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with jitter. Every attempt is logged so failures are
// traceable per external call, per the "log estruturado de cada tentativa" requirement.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      logger.info({ label: options.label, attempt, attempts }, "external_call_attempt");
      const result = await fn();
      logger.info({ label: options.label, attempt, attempts }, "external_call_success");
      return result;
    } catch (error) {
      lastError = error;
      const retryable = options.isRetryable ? options.isRetryable(error) : true;
      logger.warn(
        { label: options.label, attempt, attempts, retryable, err: error },
        "external_call_failed",
      );
      if (!retryable || attempt === attempts) {
        break;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * delay * 0.25;
      await sleep(delay + jitter);
    }
  }
  throw lastError;
}
