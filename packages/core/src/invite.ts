import { describeError, ShareStepError } from './errors.js';
import { type GraphHttp } from './http.js';
import { type DriveRef } from './graph.js';
import { type InviteDetails } from './provider.js';
import { type RetryPolicy, withRetry } from './retry.js';

export interface InviteTarget {
  folderPath: string;
  itemId: string;
  /** Link to the folder, included in the invitation message. */
  webUrl: string;
}


export interface InviteFallbackContext extends InviteDetails {
  folderPath: string;
  folderWebUrl: string;
}

/**
 * Last-resort way to share a folder with someone when the Graph invitation fails.
 * Implementations might call SharePoint REST `SP.Web.ShareObject`, which some tenants
 * still accept when Graph refuses. Throw to report that this route failed too.
 */
export type InviteFallback = (context: InviteFallbackContext) => Promise<void>;

/**
 * Sends a Graph invitation with the following fallback chain:
 *   1. Graph invite, sign-in required.
 *   2. Graph invite, sign-in not required. Some tenants reject brand-new external
 *      users in step 1 but accept them in this mode, which supports one-time-code
 *      onboarding.
 *   3. The optional `fallback`.
 * Errors from every attempt are reported together, so a failure shows all routes tried.
 */
export const inviteRecipient = async (
  http: GraphHttp,
  drive: DriveRef,
  target: InviteTarget,
  details: InviteDetails,
  retry: RetryPolicy,
  fallback?: InviteFallback
): Promise<void> => {
  const failures: string[] = [];

  const attempt = async (label: string, operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      failures.push(`${label}: ${describeError(error)}`);
      return false;
    }
  };

  if (await attempt('Graph invitation', () => sendGraphInvitation(http, drive, target, details, true, retry))) {
    return;
  }

  if (await attempt('Graph invitation without sign-in', () => sendGraphInvitation(http, drive, target, details, false, retry))) {
    return;
  }

  if (fallback && (await attempt('Fallback sharing', () => fallback({ ...details, folderPath: target.folderPath, folderWebUrl: target.webUrl })))) {
    return;
  }

  throw new ShareStepError(
    `Sharing "${target.folderPath}" with ${details.recipient}`,
    new Error(failures.join('. '))
  );
};

const sendGraphInvitation = async (
  http: GraphHttp,
  drive: DriveRef,
  target: InviteTarget,
  details: InviteDetails,
  requireSignIn: boolean,
  retry: RetryPolicy
): Promise<void> => {
  // Retrying can send a second invitation email if the first request was processed but
  // its reply was lost. Throttling and 5xx replies are retried, since those were not
  // processed.
  const response = await withRetry(
    () =>
      http.json<{ value?: { roles?: string[] }[] } | undefined>(
        'POST',
        `/sites/${drive.siteId}/drives/${drive.driveId}/items/${target.itemId}/invite`,
        {
          recipients: [{ email: details.recipient }],
          sendInvitation: true,
          requireSignIn,
          roles: [details.access],
          message: details.message
        }
      ),
    retry
  );

  // A 200 with no granted role means the recipient was rejected. Treat that as a
  // failure so the fallback chain runs.
  const granted: string[] = response?.value?.[0]?.roles ?? [];
  if (!granted.includes(details.access)) {
    throw new Error(`Graph did not confirm that ${details.access} access was granted to ${details.recipient}.`);
  }
};
