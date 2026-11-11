// An in-memory stand-in for the Dropbox HTTP API v2 endpoints a sharing client uses:
// folders, uploads (single request and upload sessions), sharing and membership.
// It is a fetch handler, so it runs in Node tests and in the browser.
//
// Error bodies follow the shapes in Dropbox's Stone API specification, including the
// offset error that tells a client where an upload session really is.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_FAKE_DROPBOX_API_URL = 'https://api.fake-dropbox.test/2';
export const DEFAULT_FAKE_DROPBOX_CONTENT_URL = 'https://content.fake-dropbox.test/2';

export interface FakeDropboxOptions {
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  /** Artificial delay for content requests, so concurrency can be observed. */
  latencyMs?: number;
}

export interface FakeRequest {
  /** The API route, e.g. "files/upload_session/append_v2". */
  route: string;
  /** The parsed argument: the JSON body for API calls, or the Dropbox-API-Arg header for content calls. */
  arg: unknown;
  /** Bytes sent by a content call. */
  bytes: Uint8Array;
  headers: Headers;
}

export type FaultEffect = { status: number; code?: string; retryAfterSeconds?: number } | 'network';

export interface FaultRule {
  /** Matched against `FakeRequest.route`. */
  route?: string;
  when?: (request: FakeRequest) => boolean;
  phase?: 'before' | 'after';
  times?: number;
  skip?: number;
  effect: FaultEffect;
}

export interface FakeDropboxInvitation {
  path: string;
  recipient: string;
  access: string;
  message: string;
}

export interface FakeDropboxStats {
  completedUploads: number;
  maxConcurrentUploads: number;
}

export interface FakeDropbox {
  apiBaseUrl: string;
  contentBaseUrl: string;
  fetch: FetchLike;
  addFault(rule: FaultRule): void;
  clearFaults(): void;
  /** Routes called, with the HTTP status that was returned (or 'network'). */
  log: { route: string; status: number | 'network' }[];
  invitations: FakeDropboxInvitation[];
  stats: FakeDropboxStats;
  /** Every folder and file, sorted, with paths shown as Dropbox displays them. */
  entries(): { path: string; folder: boolean; size: number }[];
  readFile(path: string): Uint8Array | undefined;
  sharedFolders(): { path: string; id: string }[];
  reset(): void;
}

interface Session {
  bytes: Uint8Array;
  received: number;
}

interface Entry {
  path: string;
  folder: boolean;
  content: Uint8Array;
}

interface ActiveRule {
  rule: FaultRule;
  seen: number;
  fired: number;
}

const normalize = (path: string): string => path.toLowerCase().replace(/\/+$/, '');

const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/');

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers }
  });

/** Dropbox's error envelope: a summary string plus a tagged union. */
const apiError = (status: number, summary: string, error: unknown): Response => jsonResponse(status, { error_summary: summary, error });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createFakeDropbox = (options: FakeDropboxOptions = {}): FakeDropbox => {
  const apiBaseUrl: string = (options.apiBaseUrl ?? DEFAULT_FAKE_DROPBOX_API_URL).replace(/\/$/, '');
  const contentBaseUrl: string = (options.contentBaseUrl ?? DEFAULT_FAKE_DROPBOX_CONTENT_URL).replace(/\/$/, '');
  const latencyMs: number = options.latencyMs ?? 0;

  let entries: Map<string, Entry> = new Map<string, Entry>();
  let sessions: Map<string, Session> = new Map<string, Session>();
  let sharedIds: Map<string, { id: string; path: string }> = new Map<string, { id: string; path: string }>();
  let invitations: FakeDropboxInvitation[] = [];
  let log: { route: string; status: number | 'network' }[] = [];
  let stats: FakeDropboxStats = { completedUploads: 0, maxConcurrentUploads: 0 };
  let inFlight = 0;
  let counter = 0;
  let activeRules: ActiveRule[] = [];

  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  const reset = (): void => {
    entries = new Map<string, Entry>();
    sessions = new Map<string, Session>();
    sharedIds = new Map<string, { id: string; path: string }>();
    invitations = [];
    log = [];
    stats = { completedUploads: 0, maxConcurrentUploads: 0 };
    inFlight = 0;
  };

  reset();

  const parentExists = (path: string): boolean => {
    const parent: string = parentOf(normalize(path));
    return parent === '' || entries.get(parent)?.folder === true;
  };

  const withLatency = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    inFlight++;
    stats.maxConcurrentUploads = Math.max(stats.maxConcurrentUploads, inFlight);
    try {
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      } else {
        await Promise.resolve();
      }
      return await operation();
    } finally {
      inFlight--;
    }
  };

  const pathArg = (arg: unknown): string => {
    const path: unknown = (arg as { path?: unknown } | undefined)?.path;
    return typeof path === 'string' ? path : '';
  };

  const createFolder = (path: string): Response => {
    const key: string = normalize(path);
    if (key !== '' && !parentExists(path)) {
      return apiError(409, 'path/not_found/..', { '.tag': 'path', path: { '.tag': 'not_found' } });
    }

    const existing: Entry | undefined = entries.get(key);
    if (existing) {
      const conflict: string = existing.folder ? 'folder' : 'file';
      return apiError(409, `path/conflict/${conflict}/..`, {
        '.tag': 'path',
        path: { '.tag': 'conflict', conflict: { '.tag': conflict } }
      });
    }

    entries.set(key, { path, folder: true, content: new Uint8Array(0) });
    return jsonResponse(200, { metadata: { '.tag': 'folder', name: path.split('/').pop(), path_display: path } });
  };

  const storeFile = (path: string, bytes: Uint8Array): Response => {
    if (!parentExists(path)) {
      return apiError(409, 'path/not_found/..', { '.tag': 'path', path: { '.tag': 'not_found' } });
    }
    entries.set(normalize(path), { path, folder: false, content: bytes });
    return jsonResponse(200, { name: path.split('/').pop(), path_display: path, size: bytes.byteLength });
  };

  const sessionFor = (arg: unknown): Session | Response => {
    const cursor = (arg as { cursor?: { session_id?: string; offset?: number } } | undefined)?.cursor;
    const session: Session | undefined = cursor?.session_id ? sessions.get(cursor.session_id) : undefined;
    if (!session) {
      return apiError(409, 'lookup_failed/not_found/..', { '.tag': 'lookup_failed', lookup_failed: { '.tag': 'not_found' } });
    }
    if (cursor?.offset !== session.received) {
      return apiError(409, 'lookup_failed/incorrect_offset/..', {
        '.tag': 'lookup_failed',
        lookup_failed: { '.tag': 'incorrect_offset', incorrect_offset: { correct_offset: session.received } }
      });
    }
    return session;
  };

  const append = (session: Session, bytes: Uint8Array): void => {
    const next = new Uint8Array(session.received + bytes.byteLength);
    next.set(session.bytes.subarray(0, session.received), 0);
    next.set(bytes, session.received);
    session.bytes = next;
    session.received = next.byteLength;
  };

  const routeApi = (request: FakeRequest): Response => {
    switch (request.route) {
      case 'users/get_current_account':
        return jsonResponse(200, { account_id: 'dbid:fake', name: { display_name: 'Fake account' } });

      case 'files/create_folder_v2':
        return createFolder(pathArg(request.arg));

      case 'sharing/share_folder': {
        const path: string = pathArg(request.arg);
        const key: string = normalize(path);
        const folder: Entry | undefined = entries.get(key);
        if (!folder?.folder) {
          return apiError(409, 'bad_path/not_found/..', { '.tag': 'bad_path', bad_path: { '.tag': 'not_found' } });
        }
        const already = sharedIds.get(key);
        if (already) {
          return apiError(409, 'bad_path/already_shared/..', {
            '.tag': 'bad_path',
            bad_path: { '.tag': 'already_shared', already_shared: { shared_folder_id: already.id, name: folder.path } }
          });
        }
        const id: string = nextId('sf');
        sharedIds.set(key, { id, path: folder.path });
        return jsonResponse(200, { '.tag': 'complete', shared_folder_id: id, name: folder.path });
      }

      case 'sharing/add_folder_member': {
        const { shared_folder_id, members, custom_message } = (request.arg ?? {}) as {
          shared_folder_id?: string;
          members?: { member?: { email?: string }; access_level?: { '.tag'?: string } }[];
          custom_message?: string;
        };
        const shared = [...sharedIds.values()].find((candidate) => candidate.id === shared_folder_id);
        if (!shared) {
          return apiError(409, 'access_error/invalid_shared_folder/..', { '.tag': 'access_error', access_error: { '.tag': 'invalid_shared_folder' } });
        }
        for (const member of members ?? []) {
          const email: string = member.member?.email ?? '';
          if (!EMAIL_PATTERN.test(email)) {
            return apiError(409, 'bad_member/..', { '.tag': 'bad_member' });
          }
          invitations.push({
            path: shared.path,
            recipient: email,
            access: member.access_level?.['.tag'] ?? 'unknown',
            message: custom_message ?? ''
          });
        }
        return jsonResponse(200, {});
      }

      case 'files/upload_session/start': {
        const id: string = nextId('session');
        const session: Session = { bytes: new Uint8Array(0), received: 0 };
        sessions.set(id, session);
        append(session, request.bytes);
        return jsonResponse(200, { session_id: id });
      }

      case 'files/upload_session/append_v2': {
        const session = sessionFor(request.arg);
        if (session instanceof Response) {
          return session;
        }
        append(session, request.bytes);
        return jsonResponse(200, undefined);
      }

      case 'files/upload_session/finish': {
        const session = sessionFor(request.arg);
        if (session instanceof Response) {
          return session;
        }
        append(session, request.bytes);
        const sessionId: string = (request.arg as { cursor?: { session_id?: string } }).cursor?.session_id ?? '';
        const path: string = (request.arg as { commit?: { path?: string } }).commit?.path ?? '';
        sessions.delete(sessionId);
        stats.completedUploads++;
        return storeFile(path, session.bytes);
      }

      default:
        return apiError(409, `unsupported/${request.route}`, { '.tag': 'unsupported' });
    }
  };

  const routeContent = (request: FakeRequest): Promise<Response> => {
    if (request.route === 'files/upload') {
      return withLatency(() => {
        const path: string = pathArg(request.arg);
        stats.completedUploads++;
        return storeFile(path, request.bytes);
      });
    }
    return Promise.resolve(routeApi(request));
  };

  // Faults are checked in order. `skip` lets matching requests through first.
  const takeFault = (request: FakeRequest, phase: 'before' | 'after'): FaultRule | undefined => {
    for (const active of activeRules) {
      const { rule } = active;
      if ((rule.phase ?? 'before') !== phase) continue;
      if (rule.route !== undefined && rule.route !== request.route) continue;
      if (rule.when && !rule.when(request)) continue;

      active.seen++;
      if (active.seen <= (rule.skip ?? 0)) continue;
      if (active.fired >= (rule.times ?? 1)) continue;

      active.fired++;
      return rule;
    }
    return undefined;
  };

  const faultResponse = (effect: FaultEffect): Response => {
    if (effect === 'network') {
      throw new TypeError('Failed to fetch');
    }
    const headers: Record<string, string> = effect.retryAfterSeconds !== undefined ? { 'Retry-After': String(effect.retryAfterSeconds) } : {};
    return jsonResponse(
      effect.status,
      { error_summary: effect.code ?? `injected/${effect.status}`, error: { '.tag': 'injected' } },
      headers
    );
  };

  const fetchImpl: FetchLike = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const isContent: boolean = input.startsWith(contentBaseUrl);
    if (!isContent && !input.startsWith(apiBaseUrl)) {
      return jsonResponse(404, { error_summary: 'unknown_host' });
    }

    const base: string = isContent ? contentBaseUrl : apiBaseUrl;
    const route: string = input.slice(base.length + 1).split('?')[0] ?? '';
    const headers: Headers = new Headers(init.headers);

    if (!(headers.get('Authorization') ?? '').startsWith('Bearer ')) {
      log.push({ route, status: 401 });
      return jsonResponse(401, { error_summary: 'invalid_access_token/..' });
    }

    let arg: unknown;
    if (isContent) {
      try {
        arg = JSON.parse(headers.get('Dropbox-API-Arg') ?? 'null') as unknown;
      } catch {
        arg = undefined;
      }
    } else if (typeof init.body === 'string' && init.body !== 'null') {
      arg = JSON.parse(init.body) as unknown;
    }

    const bytes: Uint8Array = init.body instanceof Blob
      ? new Uint8Array(await init.body.arrayBuffer())
      : typeof init.body === 'string' || init.body === undefined || init.body === null
        ? new Uint8Array(0)
        : new Uint8Array(init.body as ArrayBuffer);

    const request: FakeRequest = { route, arg, bytes, headers };

    const before: FaultRule | undefined = takeFault(request, 'before');
    if (before) {
      log.push({ route, status: before.effect === 'network' ? 'network' : before.effect.status });
      return faultResponse(before.effect);
    }

    const response: Response = isContent ? await routeContent(request) : routeApi(request);

    const after: FaultRule | undefined = takeFault(request, 'after');
    if (after) {
      log.push({ route, status: after.effect === 'network' ? 'network' : after.effect.status });
      return faultResponse(after.effect);
    }

    log.push({ route, status: response.status });
    return response;
  };

  return {
    apiBaseUrl,
    contentBaseUrl,
    fetch: fetchImpl,
    addFault(rule: FaultRule): void {
      activeRules.push({ rule, seen: 0, fired: 0 });
    },
    clearFaults(): void {
      activeRules = [];
    },
    get log() {
      return log;
    },
    get invitations() {
      return invitations;
    },
    get stats() {
      return stats;
    },
    entries(): { path: string; folder: boolean; size: number }[] {
      return [...entries.values()]
        .map((entry) => ({ path: entry.path, folder: entry.folder, size: entry.content.byteLength }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    readFile(path: string): Uint8Array | undefined {
      const entry: Entry | undefined = entries.get(normalize(path));
      return entry && !entry.folder ? entry.content : undefined;
    },
    sharedFolders(): { path: string; id: string }[] {
      return [...sharedIds.values()].map((shared) => ({ path: shared.path, id: shared.id }));
    },
    reset
  };
};
