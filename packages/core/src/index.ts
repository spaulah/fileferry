export { ShareClient } from './share.js';
export type {
  AudienceResult,
  FoldersSharedEvent,
  InvitationOutcome,
  ProgressEvent,
  ProgressPhase,
  ShareClientOptions,
  ShareResult
} from './share.js';

export { planShare } from './plan.js';
export type { AudienceRequest, InviteAccess, PlannedAudience, PlannedUpload, ShareRequest, SharePlan } from './plan.js';

export { GraphHttp, DEFAULT_GRAPH_BASE_URL } from './http.js';
export type { FetchLike, GraphHttpOptions } from './http.js';

export { RemoteError, NetworkError, ShareStepError, ValidationError, describeError, isTransientError } from './errors.js';

export { DEFAULT_RETRY_POLICY, withRetry, retryDelayMs } from './retry.js';
export type { RetryOptions, RetryPolicy } from './retry.js';

export type { InviteFallback, InviteFallbackContext, InviteTarget } from './invite.js';
export type { InviteDetails, ProviderConnection, StorageProvider } from './provider.js';

export { DropboxStorageProvider } from './dropbox-provider.js';
export type { DropboxProviderOptions } from './dropbox-provider.js';

export { GraphStorageProvider } from './graph-provider.js';
export type { GraphProviderOptions } from './graph-provider.js';
export { inviteRecipient } from './invite.js';

export { parseRecipients } from './recipients.js';
export type { ParsedRecipients } from './recipients.js';

export {
  assertPathLengths,
  buildCaseFolderName,
  buildFolderAbsoluteUrl,
  buildFolderPlan,
  encodeGraphPath,
  normalizePathSegment,
  normalizeRelativePath,
  DEFAULT_MAX_PATH_LENGTH
} from './paths.js';

export {
  EMPTY_SELECTION,
  collectFromEntries,
  collectFromFileList,
  isIgnoredName,
  mergeSelections
} from './selection.js';
export type { FileSelection, SelectedFile } from './selection.js';

export { assertReadable } from './readable.js';
