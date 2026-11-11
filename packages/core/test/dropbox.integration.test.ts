import { at } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { createFakeDropbox, type FakeDropbox } from '@fileferry/fake-dropbox';
import {
  DropboxStorageProvider,
  ShareClient,
  type AudienceRequest,
  type DropboxProviderOptions,
  type SelectedFile,
  type ShareRequest
} from '../src/index.js';

interface Harness {
  dropbox: FakeDropbox;
  client: ShareClient;
  sleeps: number[];
}

const makeProvider = (
  dropbox: FakeDropbox,
  overrides: Partial<DropboxProviderOptions> = {},
  sleeps: number[] = []
): DropboxStorageProvider =>
  new DropboxStorageProvider({
    accessToken: async () => 'test-token',
    apiBaseUrl: dropbox.apiBaseUrl,
    contentBaseUrl: dropbox.contentBaseUrl,
    fetch: dropbox.fetch,
    retry: { baseDelayMs: 1, maxDelayMs: 5, sleep: async (ms: number) => void sleeps.push(ms) },
    ...overrides
  });

const setup = (
  overrides: Partial<DropboxProviderOptions> & { uploadConcurrency?: number } = {},
  latencyMs = 0
): Harness => {
  const dropbox = createFakeDropbox({ latencyMs });
  const sleeps: number[] = [];

  const { uploadConcurrency, ...providerOverrides } = overrides;
  const provider = makeProvider(dropbox, providerOverrides, sleeps);

  return { dropbox, client: new ShareClient(uploadConcurrency === undefined ? { provider } : { provider, uploadConcurrency }), sleeps };
};

const selected = (relativePath: string, content = 'content'): SelectedFile => ({
  file: new File([content], relativePath.split('/').pop()!),
  relativePath
});

const text = (bytes: Uint8Array | undefined): string | undefined => (bytes ? new TextDecoder().decode(bytes) : undefined);

const CASE = '2024-001 - Smith v. Jones';

const basicRequest = (overrides: Partial<AudienceRequest> = {}): ShareRequest => ({
  caseNumber: '2024-001',
  caseTitle: 'Smith v. Jones',
  audiences: [
    {
      name: 'Client',
      folderName: 'Client',
      files: [selected('Subpoena/response.pdf', 'abc'), selected('loose.pdf', 'zz')],
      folders: ['Subpoena', 'Subpoena/Empty'],
      recipients: 'alice@example.com, bob@example.com',
      ...overrides
    }
  ]
});

describe('DropboxStorageProvider against the fake Dropbox', () => {
  it('creates folders, uploads files and invites recipients', async () => {
    const { dropbox, client } = setup();

    const result = await client.share(basicRequest());

    expect(result.audiences[0]?.invitations.map((invitation) => invitation.status)).toEqual(['invited', 'invited']);
    expect(text(dropbox.readFile(`/${CASE}/Client/Subpoena/response.pdf`))).toBe('abc');
    expect(text(dropbox.readFile(`/${CASE}/Client/loose.pdf`))).toBe('zz');
    expect(dropbox.entries().map((entry) => entry.path)).toContain(`/${CASE}/Client/Subpoena/Empty`);
  });

  it('maps write access to editor and read access to viewer', async () => {
    const { dropbox, client } = setup();

    await client.share({
      caseTitle: 'Case',
      audiences: [
        { name: 'Client', folderName: 'Client', recipients: 'editor@example.com', access: 'write' },
        { name: 'Review', folderName: 'Review', recipients: 'viewer@example.com', access: 'read' }
      ]
    });

    const access = Object.fromEntries(dropbox.invitations.map((invitation) => [invitation.recipient, invitation.access]));
    expect(access).toEqual({ 'editor@example.com': 'editor', 'viewer@example.com': 'viewer' });
  });

  it('shares each folder once and sends the link in the invitation message', async () => {
    const { dropbox, client } = setup();

    await client.share(basicRequest());

    expect(dropbox.sharedFolders().map((shared) => shared.path)).toEqual([`/${CASE}/Client`]);
    expect(at(dropbox.invitations, 0).message).toContain('https://www.dropbox.com/home/');
  });

  it('reuses an existing shared folder when a new provider shares it again', async () => {
    const { dropbox } = setup();

    // A fresh provider has no cache, so Dropbox reports the folder as already shared and the id is read from that reply.
    await new ShareClient({ provider: makeProvider(dropbox) }).share(basicRequest());
    await new ShareClient({ provider: makeProvider(dropbox) }).share(basicRequest());

    expect(dropbox.sharedFolders()).toHaveLength(1);
    expect(dropbox.invitations).toHaveLength(4);
  });

  it('does not duplicate folders when a create reply is lost after the folder was made', async () => {
    const { dropbox, client } = setup();
    dropbox.addFault({
      route: 'files/create_folder_v2',
      phase: 'after',
      effect: 'network',
      times: 2
    });

    await client.share(basicRequest());

    const folders = dropbox.entries().filter((entry) => entry.folder).map((entry) => entry.path.toLowerCase());
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toContain(`/${CASE.toLowerCase()}/client`);
  });

  it('resumes a session upload from the offset Dropbox reports after a lost append reply', async () => {
    const { dropbox, client } = setup({ simpleUploadMaxBytes: 1024, uploadChunkBytes: 100 * 1024 });
    const size: number = 350 * 1024;
    const content = new Uint8Array(size).map((_, index) => index % 251);

    dropbox.addFault({
      route: 'files/upload_session/append_v2',
      phase: 'after',
      effect: 'network',
      skip: 1,
      times: 1
    });

    await client.share({
      caseTitle: 'Big',
      audiences: [
        {
          name: 'Client',
          folderName: 'Client',
          files: [{ file: new File([content], 'big.bin'), relativePath: 'big.bin' }],
          recipients: 'a@example.com'
        }
      ]
    });

    expect(dropbox.readFile('/Big/Client/big.bin')).toEqual(content);
    expect(dropbox.stats.completedUploads).toBe(1);
  });

  it('retries a throttled upload after the Retry-After delay', async () => {
    const dropbox = createFakeDropbox();
    const sleeps: number[] = [];
    dropbox.addFault({ route: 'files/upload', effect: { status: 429, retryAfterSeconds: 1 }, times: 1 });
    const provider = makeProvider(dropbox, { retry: { baseDelayMs: 1, maxDelayMs: 10_000, sleep: async (ms: number) => void sleeps.push(ms) } });

    const result = await new ShareClient({ provider }).share(basicRequest());

    expect(result.audiences[0]?.invitations.every((invitation) => invitation.status === 'invited')).toBe(true);
    expect(sleeps).toContain(1000);
  });

  it('reports one recipient as failed when Dropbox rate-limits invitations, and invites the others', async () => {
    const { dropbox, client } = setup();
    dropbox.addFault({ route: 'sharing/add_folder_member', effect: { status: 409, code: 'rate_limit/..' }, times: 1 });

    const result = await client.share(basicRequest());

    const statuses: string[] = (result.audiences[0]?.invitations ?? []).map((invitation) => invitation.status).sort();
    expect(statuses).toEqual(['failed', 'invited']);
  });

  it('keeps Unicode file names intact in the Dropbox-API-Arg header', async () => {
    const { dropbox, client } = setup();

    await client.share({
      caseTitle: 'Case',
      audiences: [
        {
          name: 'Client',
          folderName: 'Client',
          files: [selected('Résumé.pdf', 'accents')],
          recipients: 'a@example.com'
        }
      ]
    });

    expect(text(dropbox.readFile('/Case/Client/Résumé.pdf'))).toBe('accents');
  });

  it('places everything under the configured root folder', async () => {
    const { dropbox, client } = setup({ rootPath: 'Shared/Legal' });

    await client.share(basicRequest());

    // The configured root itself is created, and everything else sits beneath it.
    const paths: string[] = dropbox.entries().map((entry) => entry.path);
    expect(paths).toContain('/Shared/Legal');
    expect(paths.every((path) => path === '/Shared' || path === '/Shared/Legal' || path.startsWith('/Shared/Legal/'))).toBe(true);
  });
});
