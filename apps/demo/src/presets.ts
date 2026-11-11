import type { FaultRule as GraphFaultRule } from '@fileferry/fake-graph';
import type { FaultRule as DropboxFaultRule } from '@fileferry/fake-dropbox';

// Each preset is a failure a real platform produces. The same story is told for each
// provider in that provider's own endpoints, so the demo shows how the engine copes with
// both without needing either tenant or account.

export interface Preset {
  id: string;
  label: string;
  description: string;
  /** Faults for the fake SharePoint (Microsoft Graph). */
  graph: GraphFaultRule[];
  /** Faults for the fake Dropbox. */
  dropbox: DropboxFaultRule[];
  /** Replace the first selected file with one that cannot be read. */
  lockFirstFile?: boolean;
}

export const CLEAN_PRESET: Preset = {
  id: 'clean',
  label: 'Clean run',
  description: 'No failures. Everything should succeed on the first try.',
  graph: [],
  dropbox: []
};

export const PRESETS: Preset[] = [
  CLEAN_PRESET,
  {
    id: 'throttled',
    label: 'Throttled uploads',
    description: 'The service answers 429 with Retry-After for the first two uploads.',
    graph: [{ method: 'PUT', path: /\/content$/, effect: { status: 429, retryAfterSeconds: 1 }, times: 2 }],
    dropbox: [{ route: 'files/upload', effect: { status: 429, retryAfterSeconds: 1 }, times: 2 }]
  },
  {
    id: 'lost-replies',
    label: 'Lost replies',
    description:
      'The server creates a folder and then drops the reply, and drops an upload reply too. A naive retry would duplicate or overwrite.',
    graph: [
      {
        method: 'POST',
        when: (request) => request.path.endsWith('/children'),
        phase: 'after',
        effect: 'network',
        times: 2
      },
      { method: 'PUT', path: /\/content$/, phase: 'after', effect: 'network', times: 1 }
    ],
    dropbox: [
      { route: 'files/create_folder_v2', phase: 'after', effect: 'network', times: 2 },
      { route: 'files/upload', phase: 'after', effect: 'network', times: 1 }
    ]
  },
  {
    id: 'flaky-network',
    label: 'Flaky network',
    description: 'Three uploads fail before reaching the server, as on a VPN that drops connections.',
    graph: [{ method: 'PUT', path: /\/content$/, effect: 'network', times: 3 }],
    dropbox: [{ route: 'files/upload', effect: 'network', times: 3 }]
  },
  {
    id: 'refused-invites',
    label: 'Refused invitations',
    description:
      'The service refuses some invitations. SharePoint refuses sign-in invitations, so the engine retries without that requirement. Dropbox rate-limits membership changes, so that recipient is reported as failed while the others succeed.',
    graph: [
      {
        method: 'POST',
        when: (request) => request.path.endsWith('/invite') && (request.json as { requireSignIn?: boolean } | undefined)?.requireSignIn === true,
        effect: { status: 400, code: 'invalidRequest', message: 'Sign-in is required for external users.' },
        times: Infinity
      }
    ],
    dropbox: [{ route: 'sharing/add_folder_member', effect: { status: 409, code: 'rate_limit/..' }, times: 1 }]
  },
  {
    id: 'locked-file',
    label: 'Locked file',
    description: 'The first selected file is open in another program and cannot be read. It is reported before anything is created.',
    graph: [],
    dropbox: [],
    lockFirstFile: true
  }
];
