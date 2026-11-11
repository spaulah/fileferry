import { RemoteError, NetworkError } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export interface GraphHttpOptions {
  /** Defaults to the Graph v1.0 endpoint. Point at a fake server for tests and demos. */
  baseUrl?: string;
  /** Returns a bearer token for Graph. Called before every authenticated request. */
  getAccessToken: () => Promise<string>;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Thin HTTP layer. It turns browser-level fetch failures into NetworkError, turns
 * non-2xx replies into RemoteError (with Retry-After parsed), and attaches the bearer
 * token only to Graph calls. Pre-authorized URLs such as upload sessions are sent
 * without it.
 */
export class GraphHttp {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: FetchLike;

  public constructor(options: GraphHttpOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/$/, '');
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Authenticated JSON call. `path` is relative to the Graph base URL, e.g. `/sites/...`. */
  public async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.authorized(method, path, body === undefined ? undefined : JSON.stringify(body), headers);
    const text: string = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Authenticated call with a raw body, such as file content. Returns the Response. */
  public authorized(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return this.getAccessToken().then((token: string) =>
      this.checked(`${this.baseUrl}${path}`, {
        method,
        body: body ?? null,
        headers: { ...headers, Authorization: `Bearer ${token}` }
      }, method)
    );
  }

  /** Call to a URL that already carries its own authorization (an upload session). */
  public preauthorized(url: string, init: RequestInit = {}): Promise<Response> {
    return this.checked(url, init, init.method ?? 'GET');
  }

  private async checked(url: string, init: RequestInit, method: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      // fetch() rejects with a TypeError only when no HTTP response arrived at all.
      if (error instanceof TypeError) {
        throw new NetworkError(error.message || 'Failed to fetch', error);
      }
      throw error;
    }

    if (!response.ok) {
      throw await toGraphError(response, method);
    }

    return response;
  }
}

const toGraphError = async (response: Response, method: string): Promise<RemoteError> => {
  const text: string = await response.text().catch(() => '');

  const { code, message } = readGraphErrorBody(text);

  // The URL is deliberately left out: upload-session URLs carry a credential.
  const retryAfterSeconds = Number(response.headers.get('Retry-After'));
  return new RemoteError(
    `${method} request failed (${response.status}): ${message || response.statusText || 'no details returned'}`,
    {
      status: response.status,
      code,
      retryAfterMs: retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined
    }
  );
};

const readGraphErrorBody = (text: string): { code: string | undefined; message: string | undefined } => {
  try {
    const parsed: unknown = JSON.parse(text);
    const error: unknown = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? parsed.error : undefined;
    if (typeof error !== 'object' || error === null) {
      return { code: undefined, message: undefined };
    }
    return {
      code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
      message: 'message' in error && typeof error.message === 'string' ? error.message : undefined
    };
  } catch {
    // Not a Graph error body; the caller falls back to the status text.
    return { code: undefined, message: undefined };
  }
};
