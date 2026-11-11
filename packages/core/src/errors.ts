// Error types used across the engine. Callers can branch on `instanceof` and on the
// structured fields instead of parsing messages.

/** The request never produced an HTTP response (dropped connection, VPN/proxy, or a
 *  throttling reply without CORS headers, which browsers report as "Failed to fetch"). */
export class NetworkError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'NetworkError';
  }
}

/** Microsoft Graph (or an upload session) answered with a non-2xx status. */
export class RemoteError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  /** Milliseconds from a `Retry-After` header, when the server sent one. */
  public readonly retryAfterMs: number | undefined;
  /** The parsed error body, when the server sent JSON. Provider-specific shape. */
  public readonly body: unknown;

  public constructor(
    message: string,
    details: { status: number; code?: string | undefined; retryAfterMs?: number | undefined; body?: unknown }
  ) {
    super(message);
    this.name = 'RemoteError';
    this.status = details.status;
    this.code = details.code;
    this.retryAfterMs = details.retryAfterMs;
    this.body = details.body;
  }
}

/** The request is invalid or cannot be carried out as described (bad emails, path too
 *  long, missing library). Nothing has been changed when this is thrown during planning. */
export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A step of the share operation failed. `step` says what was being done, so the
 *  message reads as "Uploading "Case/Client/a.pdf" failed: ...". */
export class ShareStepError extends Error {
  public readonly step: string;

  public constructor(step: string, cause: unknown) {
    super(`${step} failed: ${describeError(cause)}`, { cause });
    this.name = 'ShareStepError';
    this.step = step;
  }
}

export const TRANSIENT_STATUS_CODES: readonly number[] = [429, 500, 502, 503, 504];

/** Whether retrying the same request can reasonably succeed. */
export const isTransientError = (error: unknown): boolean =>
  error instanceof NetworkError ||
  (error instanceof RemoteError && TRANSIENT_STATUS_CODES.includes(error.status));

/** A human-readable explanation of any thrown value. */
export const describeError = (error: unknown): string => {
  if (error instanceof NetworkError) {
    return (
      'the connection to Microsoft Graph was interrupted or blocked, even after several retries ' +
      `(browser reported: "${error.message}"). This is usually a temporary network, VPN or proxy problem. ` +
      'Check your connection and try again. Work that already completed is kept.'
    );
  }

  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
};
