import { RemoteError, ValidationError } from './errors.js';
import { type GraphHttp } from './http.js';
import { type RetryPolicy, withRetry } from './retry.js';
import { encodeGraphPath, parentPathOf } from './paths.js';

export interface DriveRef {
  siteId: string;
  driveId: string;
}

export interface DriveInfo extends DriveRef {
  name: string;
  webUrl?: string | undefined;
}

export interface DriveItem {
  id: string;
  name: string;
  webUrl?: string | undefined;
}

/** Resolves a site URL such as https://contoso.sharepoint.com/sites/legal to its Graph id. */
export const resolveSiteId = async (http: GraphHttp, siteUrl: string): Promise<string> => {
  const url: URL = new URL(siteUrl);
  const sitePath: string = url.pathname.replace(/\/$/, '');
  const resource: string = sitePath && sitePath !== '/' ? `${url.hostname}:${sitePath}` : url.hostname;

  const site = await http.json<{ id: string }>('GET', `/sites/${resource}`);
  return site.id;
};

export const resolveDrive = async (http: GraphHttp, siteId: string, libraryName: string): Promise<DriveInfo> => {
  const response = await http.json<{ value: { id: string; name: string; webUrl?: string | undefined }[] }>(
    'GET',
    `/sites/${siteId}/drives`
  );

  const drive = response.value.find((candidate) => candidate.name === libraryName);
  if (!drive) {
    throw new ValidationError(`Document library "${libraryName}" was not found on the target site.`);
  }

  return { siteId, driveId: drive.id, name: drive.name, webUrl: drive.webUrl };
};

/** Server-relative path of the library, e.g. "/sites/legal/Shared Documents". */
export const libraryServerRelativePath = (drive: { webUrl?: string | undefined }, siteUrl: string, libraryName: string): string => {
  if (drive.webUrl) {
    return decodeURIComponent(new URL(drive.webUrl).pathname).replace(/\/$/, '');
  }

  const sitePath: string = decodeURIComponent(new URL(siteUrl).pathname).replace(/\/$/, '');
  return `${sitePath}/${libraryName}`;
};

const itemAddress = (drive: DriveRef, path: string): string =>
  `/sites/${drive.siteId}/drives/${drive.driveId}/root:/${encodeGraphPath(path)}`;

/** Returns undefined for a 404 and rethrows everything else. */
export const findItemByPath = async (http: GraphHttp, drive: DriveRef, path: string): Promise<DriveItem | undefined> => {
  try {
    return await http.json<DriveItem>('GET', itemAddress(drive, path));
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The existence check runs on every attempt, so a create whose response was lost is not
 * sent again. A second create with conflictBehavior=replace would replace the folder.
 */
export const getOrCreateFolder = async (
  http: GraphHttp,
  drive: DriveRef,
  path: string,
  name: string
): Promise<DriveItem> => {
  const existing: DriveItem | undefined = await findItemByPath(http, drive, path);
  if (existing) {
    return existing;
  }

  const parent: string = parentPathOf(path);
  const endpoint: string = parent
    ? `/sites/${drive.siteId}/drives/${drive.driveId}/root:/${encodeGraphPath(parent)}:/children`
    : `/sites/${drive.siteId}/drives/${drive.driveId}/root/children`;

  return http.json<DriveItem>('POST', endpoint, {
    name,
    folder: {},
    '@microsoft.graph.conflictBehavior': 'replace'
  });
};

/**
 * Creates every ancestor of `path` in order. `known` holds lowercase paths already
 * confirmed in this run, so a deep tree does not re-check each ancestor.
 */
export const ensureFolderPath = async (
  http: GraphHttp,
  drive: DriveRef,
  path: string,
  retry: RetryPolicy,
  known: Set<string>
): Promise<void> => {
  const segments: string[] = path.split('/').filter((segment: string) => segment.length > 0);

  let currentPath = '';
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (known.has(currentPath.toLowerCase())) {
      continue;
    }

    const folderPath: string = currentPath;
    await withRetry(() => getOrCreateFolder(http, drive, folderPath, segment), retry);
    known.add(folderPath.toLowerCase());
  }
};
