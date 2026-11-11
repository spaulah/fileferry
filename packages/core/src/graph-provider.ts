import { ValidationError } from './errors.js';
import { type GraphHttpOptions, GraphHttp } from './http.js';
import {
  type DriveInfo,
  type DriveItem,
  ensureFolderPath,
  findItemByPath,
  libraryServerRelativePath,
  resolveDrive,
  resolveSiteId
} from './graph.js';
import { buildFolderAbsoluteUrl } from './paths.js';
import { type InviteFallback, inviteRecipient } from './invite.js';
import type { InviteDetails, ProviderConnection, StorageProvider } from './provider.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, withRetry } from './retry.js';
import {
  CHUNK_ALIGNMENT_BYTES,
  DEFAULT_SIMPLE_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_CHUNK_BYTES,
  uploadFile as uploadFileToDrive,
  type UploadSettings
} from './upload.js';

// SharePoint limit for the full decoded server-relative path of a file or folder.
const SHAREPOINT_MAX_PATH_LENGTH = 400;

export interface GraphProviderOptions {
  /** SharePoint site, e.g. https://contoso.sharepoint.com/sites/legal */
  siteUrl: string;
  /** Document library display name, e.g. "Shared Documents". */
  libraryName: string;
  graph: GraphHttpOptions;
  retry?: Partial<RetryPolicy>;
  simpleUploadMaxBytes?: number;
  /** Must be a multiple of 320 KiB. */
  uploadChunkBytes?: number;
  maxPathLength?: number;
  inviteFallback?: InviteFallback;
}

/**
 * SharePoint and OneDrive document libraries through Microsoft Graph.
 *
 * Folder lookups are cached per path, so inviting several recipients does not repeat them.
 */
export class GraphStorageProvider implements StorageProvider {
  public readonly name: string;
  public readonly maxPathLength: number | undefined;

  private readonly options: GraphProviderOptions;
  private readonly http: GraphHttp;
  private readonly retry: RetryPolicy;
  private readonly uploadSettings: UploadSettings;
  private drive: DriveInfo | undefined;
  private readonly knownFolders: Set<string> = new Set<string>();
  private readonly items: Map<string, DriveItem> = new Map<string, DriveItem>();

  public constructor(options: GraphProviderOptions) {
    const chunkBytes: number = options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    if (chunkBytes <= 0 || chunkBytes % CHUNK_ALIGNMENT_BYTES !== 0) {
      throw new ValidationError('uploadChunkBytes must be a positive multiple of 320 KiB.');
    }

    this.options = options;
    this.name = `the "${options.libraryName}" document library`;
    this.maxPathLength = options.maxPathLength ?? SHAREPOINT_MAX_PATH_LENGTH;
    this.http = new GraphHttp(options.graph);
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.uploadSettings = {
      simpleUploadMaxBytes: options.simpleUploadMaxBytes ?? DEFAULT_SIMPLE_UPLOAD_MAX_BYTES,
      chunkBytes,
      retry: this.retry
    };
  }

  public async connect(): Promise<ProviderConnection> {
    const { siteUrl, libraryName } = this.options;
    const siteId: string = await withRetry(() => resolveSiteId(this.http, siteUrl), this.retry);
    this.drive = await withRetry(() => resolveDrive(this.http, siteId, libraryName), this.retry);
    return { pathPrefix: libraryServerRelativePath(this.drive, siteUrl, libraryName) };
  }

  public ensureFolder(path: string): Promise<void> {
    return ensureFolderPath(this.http, this.connected(), path, this.retry, this.knownFolders);
  }

  public uploadFile(path: string, file: Blob): Promise<void> {
    return uploadFileToDrive(this.http, this.connected(), path, file, this.uploadSettings);
  }

  public async folderLink(path: string): Promise<string> {
    const item: DriveItem = await this.folderItem(path);
    return item.webUrl || buildFolderAbsoluteUrl(this.options.siteUrl, this.options.libraryName, path);
  }

  public async invite(path: string, details: InviteDetails): Promise<void> {
    const drive: DriveInfo = this.connected();
    const item: DriveItem = await this.folderItem(path);
    const webUrl: string = item.webUrl || buildFolderAbsoluteUrl(this.options.siteUrl, this.options.libraryName, path);

    await inviteRecipient(
      this.http,
      { siteId: drive.siteId, driveId: drive.driveId },
      { folderPath: path, itemId: item.id, webUrl },
      details,
      this.retry,
      this.options.inviteFallback
    );
  }

  private connected(): DriveInfo {
    if (!this.drive) {
      throw new Error('connect() must be called before using the Graph provider.');
    }
    return this.drive;
  }

  private async folderItem(path: string): Promise<DriveItem> {
    const key: string = path.toLowerCase();
    const cached: DriveItem | undefined = this.items.get(key);
    if (cached) {
      return cached;
    }

    const found: DriveItem | undefined = await withRetry(
      () => findItemByPath(this.http, this.connected(), path),
      this.retry
    );
    if (!found) {
      throw new Error(`The folder "${path}" was not found.`);
    }

    this.items.set(key, found);
    return found;
  }
}
