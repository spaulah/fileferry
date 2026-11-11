import { at } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { createFakeGraph, type FakeGraph } from '@fileferry/fake-graph';
import {
  ShareClient,
  ValidationError,
  type AudienceRequest,
  type InviteFallbackContext,
  type ProgressEvent,
  type SelectedFile,
  GraphStorageProvider,
  type GraphProviderOptions,
  type ShareClientOptions,
  type ShareRequest
} from '../src/index.js';

const SITE = 'https://contoso.sharepoint.com/sites/legal';
const LIBRARY = 'Shared Documents';
const CHUNK = 320 * 1024;

interface Harness {
  graph: FakeGraph;
  client: ShareClient;
  sleeps: number[];
}

// Options that belong to the ShareClient itself. Everything else configures the provider.
const CLIENT_KEYS: readonly (keyof ShareClientOptions)[] = ['uploadConcurrency', 'onProgress', 'onFoldersShared'];

const setup = (
  overrides: Partial<GraphProviderOptions & Pick<ShareClientOptions, 'uploadConcurrency' | 'onProgress' | 'onFoldersShared'>> = {},
  graphOptions: { latencyMs?: number; siteUrl?: string } = {}
): Harness => {
  const graph = createFakeGraph({ siteUrl: SITE, libraries: [LIBRARY], latencyMs: graphOptions.latencyMs ?? 0 });
  const sleeps: number[] = [];

  const clientOptions: Partial<ShareClientOptions> = {};
  const providerOptions: Partial<GraphProviderOptions> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if ((CLIENT_KEYS as readonly string[]).includes(key)) {
      Object.assign(clientOptions, { [key]: value });
    } else {
      Object.assign(providerOptions, { [key]: value });
    }
  }

  const provider = new GraphStorageProvider({
    siteUrl: graphOptions.siteUrl ?? SITE,
    libraryName: LIBRARY,
    graph: { baseUrl: graph.baseUrl, getAccessToken: async () => 'test-token', fetch: graph.fetch },
    retry: { baseDelayMs: 1, maxDelayMs: 5, sleep: async (ms: number) => void sleeps.push(ms) },
    ...providerOptions
  });

  const client = new ShareClient({ provider, ...clientOptions });

  return { graph, client, sleeps };
};

const selected = (relativePath: string, content = 'content'): SelectedFile => ({
  file: new File([content], relativePath.split('/').pop()!),
  relativePath
});

const text = (bytes: Uint8Array | undefined): string | undefined => (bytes ? new TextDecoder().decode(bytes) : undefined);

const simpleRequest = (overrides: Partial<AudienceRequest> = {}): ShareRequest => ({
  caseNumber: '2024-001',
  caseTitle: 'Smith v. Jones',
  audiences: [
    {
      name: 'Client',
      folderName: 'Client',
      files: [selected('Subpoena/response.pdf', 'abc'), selected('loose.pdf', 'zz')],
      folders: ['Subpoena', 'Subpoena/Empty'],
      recipients: 'alice@example.com; bob@example.com',
      ...overrides
    }
  ]
});

const CASE = '2024-001 - Smith v. Jones';

describe('ShareClient against the fake Graph', () => {
  it('shares nested folders, files and invitations for every audience', async () => {
    const { graph, client } = setup();

    const result = await client.share({
      caseNumber: '2024-001',
      caseTitle: 'Smith v. Jones',
      audiences: [
        {
          name: 'Client',
          folderName: 'Client',
          files: [selected('Subpoena/response.pdf', 'abc'), selected('loose.pdf', 'zz')],
          folders: ['Subpoena', 'Subpoena/Empty'],
          recipients: 'alice@example.com; bob@example.com'
        },
        { name: 'Opposing Counsel', folderName: 'Opposing Counsel', recipients: 'carol@other.com' }
      ]
    });

    expect(result.caseFolderPath).toBe(CASE);
    expect(text(graph.readFile(`${CASE}/Client/Subpoena/response.pdf`, LIBRARY))).toBe('abc');
    expect(text(graph.readFile(`${CASE}/Client/loose.pdf`, LIBRARY))).toBe('zz');
    expect(graph.items(LIBRARY).map((item) => item.path)).toContain(`${CASE}/Client/Subpoena/Empty`);
    expect(graph.items(LIBRARY).map((item) => item.path)).toContain(`${CASE}/Opposing Counsel`);

    expect(result.audiences.map((audience) => audience.invitations.map((invitation) => invitation.status))).toEqual([
      ['invited', 'invited'],
      ['invited']
    ]);
    expect(graph.invitations.map((invitation) => invitation.recipient)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@other.com'
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('invites with write access and the folder link in the message by default', async () => {
    const { graph, client } = setup();

    await client.share(simpleRequest());

    const invitation = at(graph.invitations, 0);
    expect(invitation.roles).toEqual(['write']);
    expect(invitation.requireSignIn).toBe(true);
    expect(invitation.message).toContain('Client folder access');
    expect(invitation.message).toContain(`${SITE.replace('/sites/legal', '')}/sites/legal/Shared%20Documents/`);
  });

  it('repeating a share reuses folders and overwrites files without replacing folders', async () => {
    const { graph, client } = setup();

    await client.share(simpleRequest());
    const createsAfterFirst: number = graph.stats.folderCreates;

    await client.share(simpleRequest({ files: [selected('Subpoena/response.pdf', 'second version')] }));

    expect(graph.stats.folderCreates).toBe(createsAfterFirst);
    expect(graph.stats.replacedFolders).toBe(0);
    expect(text(graph.readFile(`${CASE}/Client/Subpoena/response.pdf`, LIBRARY))).toBe('second version');
  });

  it('does not duplicate folders when the create reply is lost after the folder was made', async () => {
    const { graph, client } = setup();
    graph.addFault({
      method: 'POST',
      when: (request) => request.path.endsWith('/children'),
      phase: 'after',
      effect: 'network',
      times: 2
    });

    await client.share(simpleRequest());

    expect(graph.stats.replacedFolders).toBe(0);
    const folders = graph.items(LIBRARY).filter((item) => item.folder).map((item) => item.path);
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toContain(`${CASE}/Client`);
  });

  it('retries a transient upload failure with backoff and then succeeds', async () => {
    const { graph, client, sleeps } = setup();
    graph.addFault({ method: 'PUT', path: /\/content$/, effect: { status: 503 }, times: 2 });

    const result = await client.share(simpleRequest());

    expect(at(result.audiences, 0).invitations.every((invitation) => invitation.status === 'invited')).toBe(true);
    expect(sleeps).toHaveLength(2);
    expect(text(graph.readFile(`${CASE}/Client/loose.pdf`, LIBRARY))).toBe('zz');
  });

  it('waits for the server Retry-After value when throttled', async () => {
    const { graph, client, sleeps } = setup({ retry: { baseDelayMs: 1, maxDelayMs: 10_000, sleep: async (ms) => void sleeps.push(ms) } });
    graph.addFault({ method: 'GET', path: '/sites/site-1/drives', effect: { status: 429, retryAfterSeconds: 3 } });

    await client.share(simpleRequest());

    expect(sleeps).toContain(3000);
  });

  it('resumes a large upload from the acknowledged byte after a lost chunk reply', async () => {
    const { graph, client } = setup({ simpleUploadMaxBytes: 1024, uploadChunkBytes: CHUNK });
    const size: number = CHUNK * 3 + 100;
    const content = new Uint8Array(size).map((_, index) => index % 251);

    graph.addFault({
      method: 'PUT',
      path: /^\/session\//,
      phase: 'after',
      effect: 'network',
      skip: 1,
      times: 1
    });

    await client.share({
      caseTitle: 'Big',
      audiences: [{ name: 'Client', folderName: 'Client', files: [{ file: new File([content], 'big.bin'), relativePath: 'big.bin' }], recipients: 'a@b.com' }]
    });

    expect(graph.readFile('Big/Client/big.bin', LIBRARY)).toEqual(content);
    expect(graph.stats.completedUploads).toBe(1);
  });

  it('falls back to an invitation without sign-in when sign-in invitations are refused', async () => {
    const { graph, client } = setup();
    graph.addFault({
      method: 'POST',
      when: (request) => request.path.endsWith('/invite') && (request.json as { requireSignIn?: boolean } | undefined)?.requireSignIn === true,
      effect: { status: 400, code: 'invalidRequest', message: 'Sign-in is required for external users.' },
      times: Infinity
    });

    const result = await client.share(simpleRequest());

    expect(at(result.audiences, 0).invitations.map((invitation) => invitation.status)).toEqual(['invited', 'invited']);
    expect(graph.invitations.every((invitation) => !invitation.requireSignIn)).toBe(true);
  });

  it('uses the custom fallback when Graph refuses, and reports only the recipient that also fails', async () => {
    const seen: InviteFallbackContext[] = [];
    const { graph, client } = setup({
      inviteFallback: async (context) => {
        seen.push(context);
        if (context.recipient !== 'good@example.com') {
          throw new Error('ShareObject refused this recipient');
        }
      }
    });
    graph.addFault({ method: 'POST', path: /\/invite$/, effect: { status: 400, code: 'invalidRequest', message: 'Rejected' }, times: Infinity });

    const result = await client.share(simpleRequest({ recipients: 'good@example.com, bad@example.com' }));

    const outcomes = Object.fromEntries(at(result.audiences, 0).invitations.map((invitation) => [invitation.recipient, invitation]));
    expect(outcomes['good@example.com']?.status).toBe('invited');
    expect(outcomes['bad@example.com']?.status).toBe('failed');
    expect(outcomes['bad@example.com']?.error).toContain('ShareObject refused this recipient');
    expect(outcomes['bad@example.com']?.error).toContain('Graph invitation');
    expect(at(seen, 0).folderWebUrl).toContain('Shared%20Documents');
  });

  it('refuses a path that is too long before anything is created', async () => {
    const { graph, client } = setup({ maxPathLength: 60 });

    await expect(client.share(simpleRequest({ files: [selected('a-very-long-file-name-that-will-not-fit.pdf')] }))).rejects.toThrow(
      /Nothing was uploaded/
    );

    expect(graph.log.filter((entry) => entry.method !== 'GET')).toEqual([]);
    expect(graph.items(LIBRARY)).toEqual([]);
  });

  it('checks that files are readable before any network call', async () => {
    const { graph, client } = setup();
    const locked = {
      size: 10,
      slice: () => ({
        arrayBuffer: async () => {
          throw new Error('NotReadableError');
        }
      })
    } as unknown as File;

    await expect(
      client.share({
        caseTitle: 'Case',
        audiences: [{ name: 'Client', folderName: 'Client', files: [{ file: locked, relativePath: 'Locked.pdf' }], recipients: 'a@b.com' }]
      })
    ).rejects.toThrow(/could not be read from this computer: "Case\/Client\/Locked\.pdf"/);

    expect(graph.log).toEqual([]);
  });

  it('validates recipients before any network call', async () => {
    const { graph, client } = setup();

    await expect(client.share(simpleRequest({ recipients: 'not-an-address' }))).rejects.toBeInstanceOf(ValidationError);
    expect(graph.log).toEqual([]);
  });

  it('names the step that failed when the site cannot be found', async () => {
    const { client } = setup({}, { siteUrl: 'https://contoso.sharepoint.com/sites/missing' });

    await expect(client.share(simpleRequest())).rejects.toThrow(
      /^Connecting to the "Shared Documents" document library failed: /
    );
  });

  it('does not retry a permission error', async () => {
    const { graph, client, sleeps } = setup();
    graph.addFault({ method: 'PUT', path: /\/content$/, effect: { status: 403, code: 'accessDenied', message: 'Denied' }, times: Infinity });

    await expect(client.share(simpleRequest({ files: [selected('a.pdf')] }))).rejects.toThrow(/^Uploading "/);
    expect(sleeps).toEqual([]);
  });

  it('keeps concurrent uploads within the configured limit', async () => {
    const { graph, client } = setup({ uploadConcurrency: 2 }, { latencyMs: 5 });
    const files = Array.from({ length: 8 }, (_, index) => selected(`file-${index}.txt`, `${index}`));

    await client.share(simpleRequest({ files, folders: [] }));

    expect(graph.stats.maxConcurrentUploads).toBeLessThanOrEqual(2);
    expect(graph.stats.completedUploads).toBe(8);
  });

  it('turns a failing follow-up into a warning and still reports the share as done', async () => {
    const { client } = setup({
      onFoldersShared: async () => {
        throw new Error('queue unavailable');
      }
    });

    const result = await client.share(simpleRequest());

    expect(at(result.audiences, 0).invitations.every((invitation) => invitation.status === 'invited')).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('queue unavailable');
  });

  it('calls the follow-up once per audience that gained an invitation', async () => {
    const calls: string[] = [];
    const { client } = setup({
      onFoldersShared: async ({ audience, invitedRecipients }) => {
        calls.push(`${audience}:${invitedRecipients.join(',')}`);
      }
    });

    await client.share({
      caseTitle: 'Case',
      audiences: [
        { name: 'Client', folderName: 'Client', recipients: 'a@b.com' },
        { name: 'Opposing', folderName: 'Opposing', recipients: 'c@d.com' }
      ]
    });

    expect(calls.sort()).toEqual(['Client:a@b.com', 'Opposing:c@d.com']);
  });

  it('reports progress for every phase without a failure', async () => {
    const events: ProgressEvent[] = [];
    const { client } = setup({ onProgress: (event) => events.push(event) });

    await client.share(simpleRequest());

    const phases = new Set(events.map((event) => event.phase));
    expect([...phases].sort()).toEqual(['connect', 'folder', 'invite', 'upload']);
    expect(events.some((event) => event.status === 'failed')).toBe(false);
    expect(events[0]).toMatchObject({ phase: 'connect', status: 'start' });
  });

  it('keeps going when a progress listener throws', async () => {
    const { client } = setup({
      onProgress: () => {
        throw new Error('UI crashed');
      }
    });

    await expect(client.share(simpleRequest())).resolves.toBeDefined();
  });
});
