import type { InviteAccess } from './plan.js';

export interface InviteDetails {
  recipient: string;
  subject: string;
  message: string;
  access: InviteAccess;
}

export interface ProviderConnection {
  /** Prefix for measuring path lengths, e.g. the library's server-relative path. */
  pathPrefix: string;
}

/**
 * A place where folders and files can be shared from. The engine decides what to share
 * and in which order; a provider only knows how to talk to one platform.
 *
 * Paths are relative to the provider's root, with "/" separators and no leading slash,
 * e.g. "Matter 2024-001/Client/brief.pdf". Each provider maps them to its own form.
 */
export interface StorageProvider {
  /** Human-readable name used in progress messages, e.g. "Dropbox". */
  readonly name: string;
  /** Limit on the full length of a path, when the engine should check it up front. */
  readonly maxPathLength: number | undefined;

  /** Verifies access and locates the root. Called once, before anything is created. */
  connect(): Promise<ProviderConnection>;
  /** Creates the folder if it does not exist. Parents are created before children. Safe to repeat. */
  ensureFolder(path: string): Promise<void>;
  /** Writes the file, replacing any existing file at that path. Safe to repeat. */
  uploadFile(path: string, file: Blob): Promise<void>;
  /** A link to the folder, included in the invitation message. */
  folderLink(path: string): Promise<string>;
  /** Gives one recipient access to the folder. Throws if the recipient was not invited. */
  invite(path: string, details: InviteDetails): Promise<void>;
}
