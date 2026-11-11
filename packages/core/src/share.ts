import { describeError, ShareStepError } from './errors.js';
import { runWithConcurrency } from './concurrency.js';
import { assertPathLengths } from './paths.js';
import { planShare, type PlannedAudience, type ShareRequest, type SharePlan } from './plan.js';
import { type InviteDetails, type StorageProvider } from './provider.js';
import { assertReadable } from './readable.js';

export type ProgressPhase = 'connect' | 'folder' | 'upload' | 'invite' | 'notify';

export interface ProgressEvent {
  phase: ProgressPhase;
  status: 'start' | 'done' | 'failed';
  message: string;
  error?: string | undefined;
}

export interface FoldersSharedEvent {
  audience: string;
  folderPath: string;
  invitedRecipients: string[];
}

export interface ShareClientOptions {
  /** Where the files go. Build one with a provider such as `GraphStorageProvider`. */
  provider: StorageProvider;
  /** Files uploaded at once. Default 3. */
  uploadConcurrency?: number;
  /** Receives progress for UI and logs. Exceptions thrown here are ignored. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Runs once per audience that gained at least one invitation, after uploads and
   * invitations finish. Use it for side effects such as notification queues. An error
   * thrown here is reported in `ShareResult.warnings` and never fails the share.
   */
  // Callbacks may be synchronous or asynchronous.
  onFoldersShared?: (event: FoldersSharedEvent) => void | Promise<void>;
}

export interface InvitationOutcome {
  recipient: string;
  status: 'invited' | 'failed';
  error?: string;
}

export interface AudienceResult {
  name: string;
  folderPath: string;
  uploadedFiles: string[];
  invitations: InvitationOutcome[];
}

export interface ShareResult {
  caseFolderPath: string;
  folders: string[];
  audiences: AudienceResult[];
  /** Non-fatal problems that happened after the files were already shared. */
  warnings: string[];
}

/**
 * Shares folders and files with external people, on any `StorageProvider`.
 *
 * What it guarantees, whichever provider is used:
 *   - Validation runs before anything is created remotely.
 *   - Folders are created parents first, so uploads never race to create them.
 *   - Uploads are limited in concurrency. Each provider retries transient failures.
 *   - Re-running a share is safe. Folders are reused and files are overwritten.
 *   - Invitations are reported per recipient. One failure does not stop the others.
 */
export class ShareClient {
  private readonly options: ShareClientOptions;
  private readonly provider: StorageProvider;
  private readonly uploadConcurrency: number;

  public constructor(options: ShareClientOptions) {
    this.options = options;
    this.provider = options.provider;
    this.uploadConcurrency = options.uploadConcurrency ?? 3;
  }

  public async share(request: ShareRequest): Promise<ShareResult> {
    // Everything that can be checked without the network is checked first.
    const plan: SharePlan = planShare(request);
    await assertReadable(plan.uploads.map((upload) => ({ label: upload.targetPath, file: upload.file })));

    const connection = await this.step('connect', `Connecting to ${this.provider.name}`, () => this.provider.connect());

    // Checked before any folder or file is created, so an over-long path leaves no partial upload.
    if (this.provider.maxPathLength !== undefined) {
      assertPathLengths(
        connection.pathPrefix,
        [...plan.folderPaths, ...plan.uploads.map((upload) => upload.targetPath)],
        this.provider.maxPathLength
      );
    }

    for (const folderPath of plan.folderPaths) {
      await this.step('folder', `Creating the "${folderPath}" folder`, () => this.provider.ensureFolder(folderPath));
    }

    await runWithConcurrency(plan.uploads, this.uploadConcurrency, (upload) =>
      this.step('upload', `Uploading "${upload.targetPath}"`, () => this.provider.uploadFile(upload.targetPath, upload.file))
    );

    const audiences: AudienceResult[] = await Promise.all(
      plan.audiences.map((audience) => this.inviteAudience(audience))
    );

    const warnings: string[] = await this.notifyAudiences(audiences);

    return {
      caseFolderPath: plan.caseFolderPath,
      folders: plan.folderPaths,
      audiences,
      warnings
    };
  }

  private async inviteAudience(audience: PlannedAudience): Promise<AudienceResult> {
    const link: string = await this.step('invite', `Preparing the "${audience.folderPath}" folder for sharing`, () =>
      this.provider.folderLink(audience.folderPath)
    );

    // The provider's own invitation email may not carry a usable link in every setting, so the
    // link is also written into the message body.
    const invitations: InvitationOutcome[] = await Promise.all(
      audience.recipients.map(async (recipient: string): Promise<InvitationOutcome> => {
        const details: InviteDetails = {
          recipient,
          subject: audience.inviteSubject,
          message: `${audience.inviteSubject}\n\nYou can access the shared folder here: ${link}`,
          access: audience.access
        };

        this.emit('invite', 'start', `Inviting ${recipient} to "${audience.folderPath}"`);
        try {
          await this.provider.invite(audience.folderPath, details);
          this.emit('invite', 'done', `Invited ${recipient} to "${audience.folderPath}"`);
          return { recipient, status: 'invited' };
        } catch (error) {
          const reason: string = describeError(error);
          this.emit('invite', 'failed', `Could not invite ${recipient} to "${audience.folderPath}"`, reason);
          return { recipient, status: 'failed', error: reason };
        }
      })
    );

    return {
      name: audience.name,
      folderPath: audience.folderPath,
      uploadedFiles: audience.uploadedFiles,
      invitations
    };
  }

  private async notifyAudiences(audiences: AudienceResult[]): Promise<string[]> {
    const { onFoldersShared } = this.options;
    const warnings: string[] = [];
    if (!onFoldersShared) {
      return warnings;
    }

    for (const audience of audiences) {
      const invitedRecipients: string[] = audience.invitations
        .filter((invitation: InvitationOutcome) => invitation.status === 'invited')
        .map((invitation: InvitationOutcome) => invitation.recipient);
      if (invitedRecipients.length === 0) {
        continue;
      }

      const description = `Recording the share for "${audience.folderPath}"`;
      this.emit('notify', 'start', description);
      try {
        await onFoldersShared({
          audience: audience.name,
          folderPath: audience.folderPath,
          invitedRecipients
        });
        this.emit('notify', 'done', description);
      } catch (error) {
        const reason: string = describeError(error);
        warnings.push(`Documents were shared, but the follow-up for "${audience.folderPath}" failed: ${reason}`);
        this.emit('notify', 'failed', description, reason);
      }
    }

    return warnings;
  }

  private async step<T>(phase: ProgressPhase, description: string, operation: () => Promise<T>): Promise<T> {
    this.emit(phase, 'start', description);
    try {
      const result: T = await operation();
      this.emit(phase, 'done', description);
      return result;
    } catch (error) {
      const stepError: ShareStepError = new ShareStepError(description, error);
      this.emit(phase, 'failed', description, describeError(error));
      throw stepError;
    }
  }

  private emit(phase: ProgressPhase, status: ProgressEvent['status'], message: string, error?: string): void {
    try {
      this.options.onProgress?.({ phase, status, message, error });
    } catch {
      // A failing progress listener must not interrupt the share.
    }
  }
}
