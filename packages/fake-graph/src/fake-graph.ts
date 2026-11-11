// An in-memory stand-in for the parts of Microsoft Graph that a SharePoint sharing
// client uses: sites, drives, folders, file content, resumable upload sessions and
// invitations. It is a plain fetch handler, so it runs in Node tests and in the browser.
//
// Its main feature is fault injection. Failures can be applied *before* a request has
// any effect, or *after* it has, with the reply then lost. The second kind is what
// makes naive retry logic create duplicates or corrupt uploads.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_FAKE_BASE_URL = 'https://graph.fake.test/v1.0';
const UPLOAD_ORIGIN = 'https://upload.fake.test';
const SITE_ID = 'site-1';

export interface FakeGraphOptions {
  /** The site the fake serves, e.g. https://contoso.sharepoint.com/sites/legal */
  siteUrl: string;
  libraries?: string[];
  baseUrl?: string;
  /** Artificial delay per upload request, so concurrency can be observed. */
  latencyMs?: number;
}

export interface FakeRequest {
  method: string;
  url: string;
  /** Path relative to the Graph base URL, or the upload-session path. */
  path: string;
  headers: Headers;
  /** Parsed JSON body, when the body was a JSON string. */
  json: unknown;
  raw: BodyInit | null | undefined;
}

export type FaultEffect =
  | { status: number; code?: string; message?: string; retryAfterSeconds?: number }
  | 'network';

export interface FaultRule {
  method?: string;
  /** Matched against `FakeRequest.path`. */
  path?: string | RegExp;
  /** Extra predicate, for example to refuse only `requireSignIn: true` invitations. */
  when?: (request: FakeRequest) => boolean;
  /**
   * `before` (default): the request has no effect and fails.
   * `after`: the request is applied, then the reply is replaced by the failure. A
   * `network` effect models a reply lost on the way back.
   */
  phase?: 'before' | 'after';
  /** How many matching requests to fail. Default 1; use Infinity for every one. */
  times?: number;
  /** How many matching requests to let through before failing. */
  skip?: number;
  effect: FaultEffect;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number | 'network';
}

export interface InvitationRecord {
  path: string;
  recipient: string;
  requireSignIn: boolean;
  roles: string[];
  message: string;
}

export interface FakeStats {
  folderCreates: number;
  /** Folder creates that replaced an existing folder. Should stay 0 when retries are correct. */
  replacedFolders: number;
  completedUploads: number;
  maxConcurrentUploads: number;
}

export interface FakeItemSnapshot {
  path: string;
  folder: boolean;
  size: number;
}

export interface FakeGraph {
  baseUrl: string;
  fetch: FetchLike;
  addFault(rule: FaultRule): void;
  clearFaults(): void;
  log: RequestLogEntry[];
  invitations: InvitationRecord[];
  stats: FakeStats;
  /** Every item in a library, sorted, for assertions. */
  items(library?: string): FakeItemSnapshot[];
  readFile(path: string, library?: string): Uint8Array | undefined;
  /** Clears content and history but keeps the configuration and faults. */
  reset(): void;
}

interface FakeItem {
  id: string;
  name: string;
  path: string;
  folder: boolean;
  content: Uint8Array;
}

interface FakeLibrary {
  id: string;
  name: string;
  items: Map<string, FakeItem>;
}

interface UploadSession {
  library: FakeLibrary;
  path: string;
  size: number;
  received: number;
  buffer: Uint8Array;
}

interface ActiveRule {
  rule: FaultRule;
  seen: number;
  fired: number;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });

const graphError = (status: number, code: string, message: string, headers: Record<string, string> = {}): Response =>
  jsonResponse(status, { error: { code, message } }, headers);

const decodePath = (encoded: string): string =>
  encoded
    .split('/')
    .filter((segment: string) => segment.length > 0)
    .map((segment: string) => decodeURIComponent(segment))
    .join('/');

const encodeSegments = (path: string): string =>
  path
    .split('/')
    .map((segment: string) => encodeURIComponent(segment))
    .join('/');

/** The `name` field of a JSON request body, or '' when absent. */
const nameOf = (json: unknown): string =>
  typeof json === 'object' && json !== null && 'name' in json && typeof json.name === 'string' ? json.name : '';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createFakeGraph = (options: FakeGraphOptions): FakeGraph => {
  const baseUrl: string = (options.baseUrl ?? DEFAULT_FAKE_BASE_URL).replace(/\/$/, '');
  const latencyMs: number = options.latencyMs ?? 0;
  const siteUrl: URL = new URL(options.siteUrl);
  const sitePath: string = siteUrl.pathname.replace(/\/$/, '');
  const siteOrigin: string = siteUrl.origin;

  let libraries: FakeLibrary[] = [];
  let itemPathById: Map<string, string> = new Map<string, string>();
  let sessions: Map<string, UploadSession> = new Map<string, UploadSession>();
  let counter = 0;
  let stats: FakeStats = { folderCreates: 0, replacedFolders: 0, completedUploads: 0, maxConcurrentUploads: 0 };
  let inFlight = 0;
  let log: RequestLogEntry[] = [];
  let invitations: InvitationRecord[] = [];
  let activeRules: ActiveRule[] = [];

  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  const reset = (): void => {
    const names: string[] = options.libraries ?? ['Shared Documents'];
    libraries = names.map((name: string) => ({ id: nextId('drive'), name, items: new Map<string, FakeItem>() }));
    itemPathById = new Map<string, string>();
    sessions = new Map<string, UploadSession>();
    stats = { folderCreates: 0, replacedFolders: 0, completedUploads: 0, maxConcurrentUploads: 0 };
    inFlight = 0;
    log = [];
    invitations = [];
  };

  reset();

  const libraryByName = (name?: string): FakeLibrary => {
    const library = name ? libraries.find((candidate) => candidate.name === name) : libraries[0];
    if (!library) {
      throw new Error(`fake-graph: no library named "${name}"`);
    }
    return library;
  };

  const libraryWebUrl = (library: FakeLibrary): string =>
    `${siteOrigin}${sitePath}/${encodeURIComponent(library.name)}`;

  const itemJson = (library: FakeLibrary, item: FakeItem): Record<string, unknown> => ({
    id: item.id,
    name: item.name,
    folder: item.folder ? {} : undefined,
    size: item.content.byteLength,
    webUrl: `${libraryWebUrl(library)}/${encodeSegments(item.path)}`
  });

  const findLibraryById = (driveId: string): FakeLibrary | undefined => libraries.find((library) => library.id === driveId);

  const parentExists = (library: FakeLibrary, path: string): boolean => {
    const parent: string = path.split('/').slice(0, -1).join('/');
    return parent === '' || library.items.get(parent.toLowerCase())?.folder === true;
  };

  const lookup = (library: FakeLibrary, path: string): FakeItem | undefined => library.items.get(path.toLowerCase());

  const registerItem = (library: FakeLibrary, path: string, folder: boolean, content?: Uint8Array): FakeItem => {
    const item: FakeItem = {
      id: nextId('item'),
      name: path.split('/').pop() ?? path,
      path,
      folder,
      content: content ?? new Uint8Array(0)
    };
    library.items.set(path.toLowerCase(), item);
    itemPathById.set(item.id, path);
    return item;
  };

  const createFolder = (library: FakeLibrary, parentPath: string, name: string): Response => {
    const path: string = parentPath ? `${parentPath}/${name}` : name;
    if (parentPath && !parentExists(library, path)) {
      return graphError(404, 'itemNotFound', `The parent folder "${parentPath}" does not exist.`);
    }

    const existing: FakeItem | undefined = lookup(library, path);
    if (existing) {
      // Graph's conflictBehavior=replace would overwrite; the fake counts it so tests can assert it never happens.
      if (existing.folder) {
        stats.replacedFolders++;
      }
      return jsonResponse(existing.folder ? 200 : 409, itemJson(library, existing));
    }

    stats.folderCreates++;
    return jsonResponse(201, itemJson(library, registerItem(library, path, true)));
  };

  const finishFile = (library: FakeLibrary, path: string, bytes: Uint8Array): FakeItem => {
    const existing: FakeItem | undefined = lookup(library, path);
    if (existing && !existing.folder) {
      existing.content = bytes;
      return existing;
    }
    return registerItem(library, path, false, bytes);
  };

  const withLatency = async <T>(operation: () => Promise<T>): Promise<T> => {
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

  const bytesOf = async (body: BodyInit | null | undefined): Promise<Uint8Array> =>
    body === undefined || body === null ? new Uint8Array(0) : new Uint8Array(await new Response(body).arrayBuffer());

  const routeDrive = async (library: FakeLibrary, rest: string, request: FakeRequest): Promise<Response> => {
    const inviteMatch: RegExpExecArray | null = /^items\/([^/]+)\/invite$/.exec(rest);
    if (inviteMatch && request.method === 'POST') {
      return invite(library, inviteMatch[1] ?? '', request.json);
    }

    if (rest === 'root/children' && request.method === 'POST') {
      return createFolder(library, '', nameOf(request.json));
    }

    const rootMatch: RegExpExecArray | null = /^root:\/(.*?)(?::\/(children|content|createUploadSession))?$/.exec(rest);
    if (!rootMatch) {
      return graphError(404, 'itemNotFound', `Unknown resource ${rest}`);
    }

    const path: string = decodePath(rootMatch[1] ?? '');
    const action: string | undefined = rootMatch[2];

    if (!action) {
      const item: FakeItem | undefined = lookup(library, path);
      return item ? jsonResponse(200, itemJson(library, item)) : graphError(404, 'itemNotFound', `"${path}" was not found.`);
    }

    if (action === 'children') {
      return createFolder(library, path, nameOf(request.json));
    }

    if (!parentExists(library, path)) {
      return graphError(404, 'itemNotFound', `The parent of "${path}" does not exist.`);
    }

    if (action === 'content') {
      return withLatency(async () => {
        const item: FakeItem = finishFile(library, path, await bytesOf(request.raw));
        stats.completedUploads++;
        return jsonResponse(201, itemJson(library, item));
      });
    }

    // createUploadSession
    const sessionId: string = nextId('session');
    sessions.set(sessionId, { library, path, size: 0, received: 0, buffer: new Uint8Array(0) });
    return jsonResponse(200, {
      uploadUrl: `${UPLOAD_ORIGIN}/session/${sessionId}?tempauth=fake`,
      expirationDateTime: new Date(Date.now() + 3600_000).toISOString()
    });
  };

  const invite = (library: FakeLibrary, itemId: string, json: unknown): Response => {
    const path: string | undefined = itemPathById.get(itemId);
    if (!path || !lookup(library, path)) {
      return graphError(404, 'itemNotFound', `Item ${itemId} was not found.`);
    }

    const body = json as { recipients?: { email?: string }[]; requireSignIn?: boolean; roles?: string[]; message?: string };
    const recipients: string[] = (body.recipients ?? []).map((recipient) => recipient.email ?? '');
    if (recipients.length === 0 || recipients.some((email: string) => !EMAIL_PATTERN.test(email))) {
      return graphError(400, 'invalidRequest', 'One or more recipients are not valid email addresses.');
    }

    const roles: string[] = body.roles ?? [];
    for (const recipient of recipients) {
      invitations.push({
        path,
        recipient,
        requireSignIn: body.requireSignIn ?? true,
        roles,
        message: body.message ?? ''
      });
    }

    return jsonResponse(200, { value: recipients.map(() => ({ id: nextId('perm'), roles })) });
  };

  const uploadChunk = async (sessionId: string, request: FakeRequest): Promise<Response> => {
    const session: UploadSession | undefined = sessions.get(sessionId);
    if (!session) {
      return graphError(404, 'itemNotFound', 'The upload session does not exist or has expired.');
    }

    if (request.method === 'GET') {
      return jsonResponse(200, { nextExpectedRanges: [`${session.received}-`] });
    }

    const range: RegExpExecArray | null = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers.get('Content-Range') ?? '');
    if (!range) {
      return graphError(400, 'invalidRequest', 'Missing or malformed Content-Range.');
    }

    const start = Number(range[1]);
    const end = Number(range[2]);
    const total = Number(range[3]);
    if (start !== session.received) {
      return jsonResponse(416, { nextExpectedRanges: [`${session.received}-`] });
    }

    return withLatency(async () => {
      const bytes: Uint8Array = await bytesOf(request.raw);
      if (session.buffer.byteLength !== total) {
        session.buffer = new Uint8Array(total);
        session.size = total;
      }
      session.buffer.set(bytes, start);
      session.received = end + 1;

      if (session.received >= total) {
        sessions.delete(sessionId);
        const item: FakeItem = finishFile(session.library, session.path, session.buffer);
        stats.completedUploads++;
        return jsonResponse(201, itemJson(session.library, item));
      }

      return jsonResponse(202, { nextExpectedRanges: [`${session.received}-`] });
    });
  };

  const handleGraph = async (request: FakeRequest): Promise<Response> => {
    const siteMatch: RegExpExecArray | null = /^\/sites\/([^/:]+):(\/.*)$/.exec(request.path);
    if (siteMatch) {
      const hostMatches: boolean = siteMatch[1] === siteUrl.hostname;
      const pathMatches: boolean = (siteMatch[2] ?? '').replace(/\/$/, '').toLowerCase() === sitePath.toLowerCase();
      return hostMatches && pathMatches
        ? jsonResponse(200, { id: SITE_ID, webUrl: siteUrl.href })
        : graphError(404, 'itemNotFound', 'The site was not found.');
    }

    const drivesMatch: RegExpExecArray | null = /^\/sites\/([^/]+)\/drives$/.exec(request.path);
    if (drivesMatch) {
      if (drivesMatch[1] !== SITE_ID) {
        return graphError(404, 'itemNotFound', 'The site was not found.');
      }
      return jsonResponse(200, {
        value: libraries.map((library) => ({ id: library.id, name: library.name, webUrl: libraryWebUrl(library) }))
      });
    }

    const driveMatch: RegExpExecArray | null = /^\/sites\/([^/]+)\/drives\/([^/]+)\/(.*)$/.exec(request.path);
    if (driveMatch) {
      const library: FakeLibrary | undefined = findLibraryById(driveMatch[2] ?? '');
      if (driveMatch[1] !== SITE_ID || !library) {
        return graphError(404, 'itemNotFound', 'The drive was not found.');
      }
      return routeDrive(library, driveMatch[3] ?? '', request);
    }

    return graphError(404, 'itemNotFound', `Unknown resource ${request.path}`);
  };

  // Faults are checked in order; a rule with `skip` lets matching requests through first.
  const takeFault = (request: FakeRequest, phase: 'before' | 'after'): FaultRule | undefined => {
    for (const active of activeRules) {
      const { rule } = active;
      if ((rule.phase ?? 'before') !== phase) continue;
      if (rule.method && rule.method !== request.method) continue;
      if (rule.path !== undefined) {
        const matches: boolean = typeof rule.path === 'string' ? rule.path === request.path : rule.path.test(request.path);
        if (!matches) continue;
      }
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
    return graphError(
      effect.status,
      effect.code ?? 'injectedFault',
      effect.message ?? `Injected ${effect.status}`,
      effect.retryAfterSeconds !== undefined ? { 'Retry-After': String(effect.retryAfterSeconds) } : {}
    );
  };

  const fetchImpl: FetchLike = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url: URL = new URL(input);
    const isUpload: boolean = url.origin === UPLOAD_ORIGIN;
    const path: string = isUpload || !input.startsWith(baseUrl) ? url.pathname : (input.slice(baseUrl.length).split('?')[0] ?? '');
    const method: string = (init.method ?? 'GET').toUpperCase();
    const headers: Headers = new Headers(init.headers);

    if (!isUpload && !input.startsWith(baseUrl)) {
      return graphError(404, 'notFound', `Unknown host ${url.origin}`);
    }

    if (!isUpload && !(headers.get('Authorization') ?? '').startsWith('Bearer ')) {
      log.push({ method, path, status: 401 });
      return graphError(401, 'InvalidAuthenticationToken', 'Access token is missing.');
    }

    let json: unknown;
    if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = undefined;
      }
    }

    const request: FakeRequest = { method, url: input, path, headers, json, raw: init.body };

    const before: FaultRule | undefined = takeFault(request, 'before');
    if (before) {
      log.push({ method, path, status: before.effect === 'network' ? 'network' : before.effect.status });
      return faultResponse(before.effect);
    }

    const response: Response = isUpload
      ? await uploadChunk(url.pathname.split('/').pop() ?? '', request)
      : await handleGraph(request);

    const after: FaultRule | undefined = takeFault(request, 'after');
    if (after) {
      log.push({ method, path, status: after.effect === 'network' ? 'network' : after.effect.status });
      return faultResponse(after.effect);
    }

    log.push({ method, path, status: response.status });
    return response;
  };

  return {
    baseUrl,
    fetch: fetchImpl,
    addFault(rule: FaultRule): void {
      activeRules.push({ rule, seen: 0, fired: 0 });
    },
    clearFaults(): void {
      activeRules = [];
    },
    get log(): RequestLogEntry[] {
      return log;
    },
    get invitations(): InvitationRecord[] {
      return invitations;
    },
    get stats(): FakeStats {
      return stats;
    },
    items(library?: string): FakeItemSnapshot[] {
      return Array.from(libraryByName(library).items.values())
        .map((item: FakeItem) => ({ path: item.path, folder: item.folder, size: item.content.byteLength }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    readFile(path: string, library?: string): Uint8Array | undefined {
      const item: FakeItem | undefined = lookup(libraryByName(library), path);
      return item && !item.folder ? item.content : undefined;
    },
    reset
  };
};
