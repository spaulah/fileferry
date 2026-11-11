import { createFakeDropbox, type FakeDropbox } from '@fileferry/fake-dropbox';
import { createFakeGraph, type FakeGraph } from '@fileferry/fake-graph';
import { DropboxStorageProvider, GraphStorageProvider, type StorageProvider } from '@fileferry/core';
import type { Preset } from './presets';

export type ProviderKind = 'graph' | 'dropbox';

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  graph: 'SharePoint and OneDrive',
  dropbox: 'Dropbox'
};

const SIM_SITE = 'https://contoso.sharepoint.com/sites/shared';
const LIBRARY = 'Shared Documents';
const DROPBOX_ROOT = 'Shared';

/** A snapshot of what the simulated service holds, shown after a run. */
export interface StoredItem {
  path: string;
  folder: boolean;
  size: number;
}

/** A simulation keeps the fake service, so the demo can show what was stored and which requests failed. */
export interface Simulation {
  provider: StorageProvider;
  stored(): StoredItem[];
  requests(): { total: number; failed: number };
  /** Folders replaced by mistake. SharePoint only: its fake reports this; Dropbox's does not. */
  replacedFolders: number | undefined;
}

const isFailure = (status: number | 'network'): boolean => status === 'network' || status >= 400;

const fastRetry = { baseDelayMs: 300, maxDelayMs: 2000 };

/** Builds the fake service for a provider and applies the preset's faults to it. */
export const simulate = (kind: ProviderKind, preset: Preset): Simulation => {
  if (kind === 'graph') {
    const graph: FakeGraph = createFakeGraph({ siteUrl: SIM_SITE, libraries: [LIBRARY], latencyMs: 30 });
    preset.graph.forEach((rule) => {
      graph.addFault(rule);
    });

    return {
      provider: new GraphStorageProvider({
        siteUrl: SIM_SITE,
        libraryName: LIBRARY,
        graph: { baseUrl: graph.baseUrl, getAccessToken: () => Promise.resolve('demo-token'), fetch: graph.fetch },
        retry: fastRetry
      }),
      stored: () => graph.items(LIBRARY).map((item) => ({ path: item.path, folder: item.folder, size: item.size })),
      requests: () => ({
        total: graph.log.length,
        failed: graph.log.filter((entry) => isFailure(entry.status)).length
      }),
      get replacedFolders() {
        return graph.stats.replacedFolders;
      }
    };
  }

  const dropbox: FakeDropbox = createFakeDropbox({ latencyMs: 30 });
  preset.dropbox.forEach((rule) => {
    dropbox.addFault(rule);
  });

  return {
    provider: new DropboxStorageProvider({
      accessToken: () => Promise.resolve('demo-token'),
      rootPath: DROPBOX_ROOT,
      apiBaseUrl: dropbox.apiBaseUrl,
      contentBaseUrl: dropbox.contentBaseUrl,
      fetch: dropbox.fetch,
      retry: fastRetry
    }),
    stored: () => dropbox.entries().map((entry) => ({ path: entry.path, folder: entry.folder, size: entry.size })),
    requests: () => ({
      total: dropbox.log.length,
      failed: dropbox.log.filter((entry) => isFailure(entry.status)).length
    }),
    replacedFolders: undefined
  };
};

export interface LiveSettings {
  siteUrl: string;
  token: string;
}

/**
 * A provider for a real account. The token is used only for requests and is never stored.
 * Throws a readable message when a setting is missing.
 */
export const liveProvider = (kind: ProviderKind, settings: LiveSettings): StorageProvider => {
  const token: string = settings.token.trim();
  if (!token) {
    throw new Error(`Enter a ${PROVIDER_LABELS[kind]} access token.`);
  }

  if (kind === 'graph') {
    const siteUrl: string = settings.siteUrl.trim();
    if (!siteUrl) {
      throw new Error('Enter the SharePoint site URL.');
    }
    return new GraphStorageProvider({
      siteUrl,
      libraryName: LIBRARY,
      graph: { getAccessToken: () => Promise.resolve(token), fetch: (input, init) => fetch(input, init) }
    });
  }

  return new DropboxStorageProvider({
    accessToken: () => Promise.resolve(token),
    rootPath: DROPBOX_ROOT,
    fetch: (input, init) => fetch(input, init)
  });
};
