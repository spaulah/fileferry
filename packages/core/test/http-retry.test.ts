import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  RemoteError,
  GraphHttp,
  NetworkError,
  retryDelayMs,
  withRetry
} from '../src/index.js';
import { uploadFile } from '../src/upload.js';

const jsonResponse = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

const noWait = { sleep: async () => undefined };
const policy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1, maxDelayMs: 10 };

describe('withRetry', () => {
  it('retries a transient failure until it succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new RemoteError('busy', { status: 503 }))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, policy, noWait)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts', async () => {
    const operation = vi.fn(async () => {
      throw new NetworkError('Failed to fetch');
    });

    await expect(withRetry(operation, { ...policy, maxAttempts: 4 }, noWait)).rejects.toBeInstanceOf(NetworkError);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-transient errors', async () => {
    const operation = vi.fn(async () => {
      throw new RemoteError('forbidden', { status: 403 });
    });

    await expect(withRetry(operation, policy, noWait)).rejects.toMatchObject({ status: 403 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('runs beforeRetry after the delay and before the next attempt', async () => {
    const order: string[] = [];
    const operation = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        order.push('attempt-1');
        throw new RemoteError('busy', { status: 429 });
      })
      .mockImplementationOnce(async () => {
        order.push('attempt-2');
      });

    await withRetry(operation, policy, {
      sleep: async () => {
        order.push('sleep');
      },
      beforeRetry: async () => {
        order.push('before-retry');
      }
    });

    expect(order).toEqual(['attempt-1', 'sleep', 'before-retry', 'attempt-2']);
  });
});

describe('retryDelayMs', () => {
  it('uses exponential backoff capped at maxDelayMs', () => {
    const error = new NetworkError('x');
    expect(retryDelayMs(error, 1, DEFAULT_RETRY_POLICY)).toBe(1000);
    expect(retryDelayMs(error, 2, DEFAULT_RETRY_POLICY)).toBe(2000);
    expect(retryDelayMs(error, 10, DEFAULT_RETRY_POLICY)).toBe(30000);
  });

  it('prefers the server Retry-After value, still capped', () => {
    expect(retryDelayMs(new RemoteError('x', { status: 429, retryAfterMs: 5000 }), 1, DEFAULT_RETRY_POLICY)).toBe(5000);
    expect(retryDelayMs(new RemoteError('x', { status: 429, retryAfterMs: 600000 }), 1, DEFAULT_RETRY_POLICY)).toBe(30000);
  });
});

describe('GraphHttp', () => {
  it('sends the bearer token to Graph and parses JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'site-1' }));
    const http = new GraphHttp({ baseUrl: 'https://graph.test/v1.0', getAccessToken: async () => 'token-1', fetch: fetchMock });

    await expect(http.json<{ id: string }>('GET', '/sites/x')).resolves.toEqual({ id: 'site-1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.test/v1.0/sites/x');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token-1');
  });

  it('turns a browser-level fetch failure into NetworkError', async () => {
    const http = new GraphHttp({
      getAccessToken: async () => 't',
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      }
    });

    await expect(http.json('GET', '/me')).rejects.toBeInstanceOf(NetworkError);
  });

  it('turns an error reply into RemoteError with the Graph code and Retry-After', async () => {
    const http = new GraphHttp({
      getAccessToken: async () => 't',
      fetch: async () =>
        jsonResponse(429, { error: { code: 'activityLimitReached', message: 'Slow down' } }, { 'Retry-After': '7' })
    });

    const error = (await http.json('GET', '/me').catch((caught: unknown) => caught)) as RemoteError;
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.status).toBe(429);
    expect(error.code).toBe('activityLimitReached');
    expect(error.retryAfterMs).toBe(7000);
    expect(error.message).toContain('Slow down');
  });

  it('does not send the bearer token to pre-authorized upload URLs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const http = new GraphHttp({ getAccessToken: async () => 'secret', fetch: fetchMock });

    await http.preauthorized('https://upload.test/session?tempauth=abc');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });
});

describe('uploadFile', () => {
  const chunk = 320 * 1024;
  const drive = { siteId: 's', driveId: 'd' };

  it('uses a single PUT for small files', async () => {
    const calls: string[] = [];
    const http = new GraphHttp({
      getAccessToken: async () => 't',
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${url}`);
        return jsonResponse(201, {});
      }
    });

    await uploadFile(http, drive, 'Case/a.pdf', new Blob(['hello']), {
      simpleUploadMaxBytes: 1024,
      chunkBytes: chunk,
      retry: policy
    });

    expect(calls).toEqual(['PUT https://graph.microsoft.com/v1.0/sites/s/drives/d/root:/Case/a.pdf:/content']);
  });

  it('resumes a chunked upload from the byte the session reports after a lost reply', async () => {
    const size = chunk * 2;
    const ranges: string[] = [];
    let chunkCalls = 0;

    const http = new GraphHttp({
      getAccessToken: async () => 't',
      fetch: async (url, init) => {
        if (url.includes(':/createUploadSession')) {
          return jsonResponse(200, { uploadUrl: 'https://upload.test/session' });
        }

        if (url === 'https://upload.test/session' && init?.method === 'PUT') {
          chunkCalls++;
          ranges.push((init.headers as Record<string, string>)['Content-Range'] ?? '');
          // The first chunk is received but the reply is lost; the retry must resume after it.
          if (chunkCalls === 1) {
            throw new TypeError('Failed to fetch');
          }
          return jsonResponse(202, { nextExpectedRanges: [] });
        }

        if (url === 'https://upload.test/session') {
          return jsonResponse(200, { nextExpectedRanges: [`${chunk}-`] });
        }

        throw new Error(`unexpected call ${url}`);
      }
    });

    await uploadFile(http, drive, 'Case/big.bin', new Blob([new Uint8Array(size)]), {
      simpleUploadMaxBytes: 1024,
      chunkBytes: chunk,
      retry: { ...policy }
    });

    // The first chunk's reply was lost. The retry asks the session where to resume and
    // continues from the byte it reports, so the second request starts at byte `chunk`.
    expect(ranges).toEqual([`bytes 0-${chunk - 1}/${size}`, `bytes ${chunk}-${size - 1}/${size}`]);
    expect(chunkCalls).toBe(2);
  });
});
