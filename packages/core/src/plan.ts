import { ValidationError } from './errors.js';
import { parseRecipients } from './recipients.js';
import { type SelectedFile } from './selection.js';
import {
  buildCaseFolderName,
  buildFolderPlan,
  normalizePathSegment,
  normalizeRelativePath
} from './paths.js';

export type InviteAccess = 'read' | 'write';

/** One group of people who receive a shared folder, e.g. the client or opposing counsel. */
export interface AudienceRequest {
  /** Label used in results and messages, e.g. "Client". */
  name: string;
  /** Folder created under the case folder, e.g. "Client". */
  folderName: string;
  files?: SelectedFile[];
  /** Selected subfolders relative to the audience's selection root. Empty ones are created too. */
  folders?: string[];
  /** Raw recipient input: commas, semicolons or newlines. */
  recipients?: string;
  /** Subject of the invitation email. Defaults to "<name> folder access". */
  inviteSubject?: string;
  /** Defaults to "write". */
  access?: InviteAccess;
}

export interface ShareRequest {
  caseNumber?: string;
  caseTitle: string;
  audiences: AudienceRequest[];
}

export interface PlannedUpload {
  targetPath: string;
  file: File;
}

export interface PlannedAudience {
  name: string;
  folderPath: string;
  recipients: string[];
  inviteSubject: string;
  access: InviteAccess;
  uploads: PlannedUpload[];
  uploadedFiles: string[];
}

export interface SharePlan {
  caseFolderPath: string;
  audiences: PlannedAudience[];
  /** Every folder to create, parents first. */
  folderPaths: string[];
  uploads: PlannedUpload[];
}

const audienceUploadTargets = (audienceFolderPath: string, files: SelectedFile[]): PlannedUpload[] =>
  files.map(({ file, relativePath }: SelectedFile) => {
    const segments: string[] = relativePath.split('/');
    const fileName: string = segments.pop() || file.name;
    const folder: string = normalizeRelativePath(segments.join('/'));
    return {
      targetPath: folder ? `${audienceFolderPath}/${folder}/${fileName}` : `${audienceFolderPath}/${fileName}`,
      file
    };
  });

/**
 * Validates a request and builds the full set of folders and uploads. Pure: no network
 * calls, so every rule can be tested and users see mistakes before anything changes.
 */
export const planShare = (request: ShareRequest): SharePlan => {
  const caseFolderPath: string = buildCaseFolderName(request.caseNumber, request.caseTitle);
  if (!caseFolderPath) {
    throw new ValidationError('Enter a case title or case number before sharing.');
  }

  const invalidAddresses: string[] = [];
  const seenNames: Set<string> = new Set<string>();
  const seenFolders: Set<string> = new Set<string>();
  const audiences: PlannedAudience[] = [];
  const selectedFolderPaths: string[] = [];

  for (const audience of request.audiences) {
    const folderName: string = normalizePathSegment(audience.folderName);
    if (!folderName) {
      throw new ValidationError(`The "${audience.name}" group needs a folder name.`);
    }
    if (seenNames.has(audience.name.toLowerCase()) || seenFolders.has(folderName.toLowerCase())) {
      throw new ValidationError(`Two groups share the name or folder "${audience.name}". Give each group its own.`);
    }
    seenNames.add(audience.name.toLowerCase());
    seenFolders.add(folderName.toLowerCase());

    const recipients = parseRecipients(audience.recipients ?? '');
    invalidAddresses.push(...recipients.invalid);

    const files: SelectedFile[] = audience.files ?? [];
    const folders: string[] = (audience.folders ?? []).map(normalizeRelativePath).filter((folder: string) => folder.length > 0);

    // An audience with nothing selected and no recipients takes no part in the share.
    if (files.length === 0 && folders.length === 0 && recipients.valid.length === 0) {
      continue;
    }

    if (files.length > 0 && recipients.valid.length === 0) {
      throw new ValidationError(`Add at least one valid email address for ${audience.name} before sharing their files.`);
    }

    const folderPath = `${caseFolderPath}/${folderName}`;
    const uploads: PlannedUpload[] = audienceUploadTargets(folderPath, files);

    folders.forEach((folder: string) => selectedFolderPaths.push(`${folderPath}/${folder}`));
    selectedFolderPaths.push(folderPath);

    audiences.push({
      name: audience.name,
      folderPath,
      recipients: recipients.valid,
      inviteSubject: audience.inviteSubject?.trim() || `${audience.name} folder access`,
      access: audience.access ?? 'write',
      uploads,
      uploadedFiles: files.map((item: SelectedFile) => item.relativePath)
    });
  }

  if (invalidAddresses.length > 0) {
    throw new ValidationError(`Invalid email addresses: ${Array.from(new Set(invalidAddresses)).join(', ')}`);
  }

  if (audiences.every((audience: PlannedAudience) => audience.recipients.length === 0)) {
    throw new ValidationError('Add at least one recipient email address before sharing.');
  }

  const uploads: PlannedUpload[] = audiences.flatMap((audience: PlannedAudience) => audience.uploads);
  const folderPaths: string[] = buildFolderPlan(
    [caseFolderPath, ...selectedFolderPaths],
    uploads.map((upload: PlannedUpload) => upload.targetPath)
  );

  return { caseFolderPath, audiences, folderPaths, uploads };
};
