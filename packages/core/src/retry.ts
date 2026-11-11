import { RemoteError, isTransientError } from './errors.js';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Replaceable so tests run without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30000
};

export interface RetryOptions {
  /** Runs after the delay and before the next attempt, e.g. to ask an upload session
   *  where to resume. */
  beforeRetry?: (error: unknown) => Promise<void>;
  /** Replaceable so tests run without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Server-provided Retry-After wins; otherwise exponential backoff, capped. */
export const retryDelayMs = (error: unknown, attempt: number, policy: RetryPolicy): number => {
  const serverDelay: number | undefined = error instanceof RemoteError ? error.retryAfterMs : undefined;
  const delay: number = serverDelay ?? policy.baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
};

/** Retries only transient failures. Non-transient errors are thrown immediately. */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  options: RetryOptions = {}
): Promise<T> => {
  const wait: (ms: number) => Promise<void> = options.sleep ?? policy.sleep ?? sleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= policy.maxAttempts || !isTransientError(error)) {
        throw error;
      }

      await wait(retryDelayMs(error, attempt, policy));
      if (options.beforeRetry) {
        await options.beforeRetry(error);
      }
    }
  }
};
