import { describeError, NetworkError, RemoteError, ValidationError } from './errors.js';
import type { FetchLike } from './http.js';
import type { InviteDetails, ProviderConnection, StorageProvider } from './provider.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, withRetry } from './retry.js';

export const DROPBOX_API_BASE_URL = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT_BASE_URL = 'https://content.dropboxapi.com/2';

// Dropbox's documented limit for a single-request upload is 150 MiB. Sessions are used
// well below that, to keep each request small and resumable.
const DEFAULT_SIMPLE_UPLOAD_MAX_BYTES: number = 8 * 1024 * 1024;
const DEFAULT_UPLOAD_CHUNK_BYTES: number = 8 * 1024 * 1024;
const MAX_OFFSET_RECOVERIES = 5;

export interface DropboxProviderOptions {
  /** Returns a bearer token with the files.content.* and sharing.write scopes. Called before every request. */
  accessToken: () => Promise<string>;
  /** Folder inside the account that acts as the root, e.g. "Shared/Legal". Default: the account root. */
  rootPath?: string;
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  fetch?: FetchLike;
  retry?: Partial<RetryPolicy>;
  simpleUploadMaxBytes?: number;
  uploadChunkBytes?: number;
}

/**
 * Dropbox, through the HTTP API v2.
 *
 * Sharing works in two steps, as in Dropbox's own API: the folder is first shared (which
 * gives it a shared folder id), then each recipient is added as a member with an access
 * level. Dropbox sends its own invitation email when a member is added.
 *
 * Built from Dropbox's public Stone API specification. It has not yet been run against a
 * live account. Items marked UNVERIFIED in docs/DESIGN.md are the first things to check.
 */
export class DropboxStorageProvider implements StorageProvider {
  public readonly name: string = 'Dropbox';
  // Dropbox documents no path length limit that this engine checks, so none is applied.
  public readonly maxPathLength: number | undefined = undefined;

  private readonly options: DropboxProviderOptions;
  private readonly rootSegments: string[];
  private readonly retry: RetryPolicy;
  private readonly simpleUploadMaxBytes: number;
  private readonly chunkBytes: number;
  private readonly fetchImpl: FetchLike;
  private readonly sharedFolderIds: Map<string, string> = new Map<string, string>();

  public constructor(options: DropboxProviderOptions) {
    const chunkBytes: number = options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    if (chunkBytes <= 0) {
      throw new ValidationError('uploadChunkBytes must be positive.');
    }

    this.options = options;
    this.rootSegments = (options.rootPath ?? '').split('/').filter((segment: string) => segment.length > 0);
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.simpleUploadMaxBytes = options.simpleUploadMaxBytes ?? DEFAULT_SIMPLE_UPLOAD_MAX_BYTES;
    this.chunkBytes = chunkBytes;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  public async connect(): Promise<ProviderConnection> {
    // Confirms the token works before anything is created.
    await this.rpc('users/get_current_account', undefined);

    // Dropbox requires parent folders to exist, so a configured root is created here, top down.
    for (let depth = 1; depth <= this.rootSegments.length; depth++) {
      await this.createFolderAt(`/${this.rootSegments.slice(0, depth).join('/')}`);
    }

    return { pathPrefix: '' };
  }

  public ensureFolder(path: string): Promise<void> {
    return this.createFolderAt(this.dropboxPath(path));
  }

  public async uploadFile(path: string, file: Blob): Promise<void> {
    const dropboxPath: string = this.dropboxPath(path);
    const commit = { path: dropboxPath, mode: { '.tag': 'overwrite' }, autorename: false, mute: false };

    if (file.size <= this.simpleUploadMaxBytes) {
      await withRetry(() => this.content('files/upload', commit, file), this.retry);
      return;
    }

    await this.uploadInSession(file, commit);
  }

  public folderLink(path: string): Promise<string> {
    // The link to the owner's own view of the folder. Recipients use the link in Dropbox's email.
    // UNVERIFIED: a recipient's access to this URL depends on how the folder was shared.
    return Promise.resolve(`https://www.dropbox.com/home${this.dropboxPath(path)}`);
  }

  public async invite(path: string, details: InviteDetails): Promise<void> {
    const sharedFolderId: string = await this.sharedFolderIdFor(path);

    await withRetry(
      () =>
        this.rpc('sharing/add_folder_member', {
          shared_folder_id: sharedFolderId,
          members: [
            {
              member: { '.tag': 'email', email: details.recipient },
              access_level: { '.tag': details.access === 'write' ? 'editor' : 'viewer' }
            }
          ],
          custom_message: details.message,
          quiet: false
        }),
      this.retry
    );
  }

  /** Creates one folder at a Dropbox path. An existing folder is success, which also covers a create whose reply was lost. */
  private async createFolderAt(dropboxPath: string): Promise<void> {
    try {
      await withRetry(() => this.rpc('files/create_folder_v2', { path: dropboxPath, autorename: false }), this.retry);
    } catch (error) {
      if (isFolderConflict(error)) {
        return;
      }
      throw error;
    }
  }

  /** The root-relative path as Dropbox expects it: leading slash, empty string for the root itself. */
  private dropboxPath(path: string): string {
    const segments: string[] = [...this.rootSegments, ...path.split('/').filter((segment: string) => segment.length > 0)];
    return segments.length === 0 ? '' : `/${segments.join('/')}`;
  }

  private async sharedFolderIdFor(path: string): Promise<string> {
    const dropboxPath: string = this.dropboxPath(path);
    const cached: string | undefined = this.sharedFolderIds.get(dropboxPath.toLowerCase());
    if (cached) {
      return cached;
    }

    let id: string | undefined;
    try {
      const launch: unknown = await withRetry(
        () => this.rpc('sharing/share_folder', { path: dropboxPath, force_async: false }),
        this.retry
      );
      id = findSharedFolderId(launch);
    } catch (error) {
      // A folder that is already shared is reported as an error that still carries its id.
      id = findSharedFolderId(error instanceof RemoteError ? error.body : undefined);
      if (!id) {
        throw error;
      }
    }

    if (!id) {
      throw new Error(`Dropbox did not return an id for the shared folder "${path}".`);
    }

    this.sharedFolderIds.set(dropboxPath.toLowerCase(), id);
    return id;
  }

  // Dropbox sessions: start with the first chunk, append the middle chunks, finish with the last.
  // If a reply was lost, the server reports the offset it actually holds; resume from there.
  private async uploadInSession(file: Blob, commit: object): Promise<void> {
    let offset = 0;
    let sessionId: string | undefined;
    let recoveries = 0;

    for (;;) {
      const end: number = Math.min(offset + this.chunkBytes, file.size);
      const bytes: Blob = file.slice(offset, end);

      try {
        if (sessionId === undefined) {
          const started = await withRetry(
            () => this.content('files/upload_session/start', { close: false }, bytes),
            this.retry
          );
          sessionId = readSessionId(started);
          offset = end;
          continue;
        }

        if (end === file.size) {
          await withRetry(
            () => this.content('files/upload_session/finish', { cursor: { session_id: sessionId, offset }, commit }, bytes),
            this.retry
          );
          return;
        }

        await withRetry(
          () => this.content('files/upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, bytes),
          this.retry
        );
        offset = end;
      } catch (error) {
        const correctOffset: number | undefined = findCorrectOffset(error);
        if (correctOffset === undefined || correctOffset === offset || recoveries >= MAX_OFFSET_RECOVERIES) {
          throw error;
        }
        recoveries++;
        offset = correctOffset;
      }
    }
  }

  /** JSON call to api.dropboxapi.com. `arg` undefined sends the JSON `null` that no-argument routes expect. */
  private async rpc(route: string, arg: unknown): Promise<unknown> {
    const token: string = await this.options.accessToken();
    const response: Response = await this.send(
      `${this.options.apiBaseUrl ?? DROPBOX_API_BASE_URL}/${route}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(arg ?? null)
      },
      route
    );
    return readJson(response);
  }

  /** Content call: the argument travels in the Dropbox-API-Arg header, the bytes in the body. */
  private async content(route: string, arg: unknown, bytes: Blob): Promise<unknown> {
    const token: string = await this.options.accessToken();
    const response: Response = await this.send(
      `${this.options.contentBaseUrl ?? DROPBOX_CONTENT_BASE_URL}/${route}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': asciiJson(arg),
          'Content-Type': 'application/octet-stream'
        },
        body: bytes
      },
      route
    );
    return readJson(response);
  }

  private async send(url: string, init: RequestInit, route: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NetworkError(error.message || 'Failed to fetch', error);
      }
      throw error;
    }

    if (!response.ok) {
      throw await toDropboxError(response, route);
    }
    return response;
  }
}

/** Dropbox's header form requires non-ASCII characters to be escaped. */
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u007f-￿]/g, (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

const readJson = async (response: Response): Promise<unknown> => {
  const text: string = await response.text();
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
};

const toDropboxError = async (response: Response, route: string): Promise<RemoteError> => {
  const text: string = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }

  const summary: string | undefined = typeof (body as { error_summary?: unknown } | undefined)?.error_summary === 'string'
    ? (body as { error_summary: string }).error_summary
    : undefined;

  const retryAfterSeconds = Number(response.headers.get('Retry-After'));
  return new RemoteError(`${route} failed (${response.status}): ${summary ?? (response.statusText || 'no details returned')}`, {
    status: response.status,
    code: summary,
    retryAfterMs: retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined,
    body
  });
};

/** True when `files/create_folder_v2` reported that a folder already exists at the path. */
const isFolderConflict = (error: unknown): boolean => {
  if (!(error instanceof RemoteError)) {
    return false;
  }
  const body = error.body as { error?: { '.tag'?: string; path?: { '.tag'?: string; conflict?: { '.tag'?: string } } } } | undefined;
  return body?.error?.['.tag'] === 'path' && body.error.path?.['.tag'] === 'conflict' && body.error.path.conflict?.['.tag'] === 'folder';
};

/** Depth-first search for a key anywhere in a parsed JSON value. Dropbox nests union payloads. */
const findKey = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (key in value) {
    return (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value)) {
    const found: unknown = findKey(child, key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

const findSharedFolderId = (value: unknown): string | undefined => {
  const id: unknown = findKey(value, 'shared_folder_id');
  return typeof id === 'string' ? id : undefined;
};

const readSessionId = (started: unknown): string => {
  const id: unknown = findKey(started, 'session_id');
  if (typeof id !== 'string') {
    throw new Error(`Dropbox did not return an upload session id: ${describeError(started)}`);
  }
  return id;
};

/** The offset the server actually holds, if a session call reported one. */
const findCorrectOffset = (error: unknown): number | undefined => {
  if (!(error instanceof RemoteError)) {
    return undefined;
  }
  const offset: unknown = findKey(error.body, 'correct_offset');
  return typeof offset === 'number' ? offset : undefined;
};
