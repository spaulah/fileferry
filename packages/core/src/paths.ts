import { ValidationError } from './errors.js';

// SharePoint limit for the full decoded server-relative path of a file or folder.
export const DEFAULT_MAX_PATH_LENGTH = 400;

// Characters SharePoint rejects in file and folder names, plus "#" and "%", which
// break URLs.
const RESERVED_CHARACTERS = /["*:<>?/\\|#%]+/g;

/** Makes one path segment safe for SharePoint: reserved characters become "-", runs of
 *  whitespace collapse, and the ends are trimmed. */
export const normalizePathSegment = (value: string): string =>
  value.replace(RESERVED_CHARACTERS, '-').replace(/\s+/g, ' ').trim();

export const splitPath = (path: string): string[] => path.split('/').filter((segment: string) => segment.length > 0);

/** Normalizes every segment of a forward-slash path and drops empty ones. */
export const normalizeRelativePath = (path: string): string =>
  path
    .split('/')
    .map(normalizePathSegment)
    .filter((segment: string) => segment.length > 0)
    .join('/');

/** Case folder name from an optional case number and a title. Identical number and
 *  title collapse to one, so "Smith v. Jones / Smith v. Jones" is not repeated. */
export const buildCaseFolderName = (caseNumber: string | undefined, caseTitle: string): string => {
  const normalizedNumber: string = normalizePathSegment(caseNumber ?? '');
  const normalizedTitle: string = normalizePathSegment(caseTitle);

  if (!normalizedNumber) {
    return normalizedTitle;
  }
  if (!normalizedTitle) {
    return normalizedNumber;
  }
  if (normalizedNumber.toLowerCase() === normalizedTitle.toLowerCase()) {
    return normalizedTitle;
  }
  return `${normalizedNumber} - ${normalizedTitle}`;
};

/** Percent-encodes each segment for use in a Graph `root:/path:` address. */
export const encodeGraphPath = (path: string): string =>
  splitPath(path).map((segment: string) => encodeURIComponent(segment)).join('/');

export const parentPathOf = (path: string): string => path.split('/').slice(0, -1).join('/');

/** Throws before anything is created if any resulting path would exceed SharePoint's limit. */
export const assertPathLengths = (
  libraryServerRelativePath: string,
  paths: readonly string[],
  maxLength: number = DEFAULT_MAX_PATH_LENGTH
): void => {
  const tooLong: string[] = paths.filter((path: string) => `${libraryServerRelativePath}/${path}`.length > maxLength);

  if (tooLong.length > 0) {
    throw new ValidationError(
      `SharePoint limits the full path of a file or folder to ${maxLength} characters, ` +
        `and these would be longer: ${tooLong.map((path: string) => `"${path}"`).join(', ')}. ` +
        'Shorten the folder or file names (or the case name) and try again. Nothing was uploaded.'
    );
  }
};

/**
 * Every folder that must exist, parents before children, without duplicates
 * (SharePoint paths are case-insensitive). Each folder's ancestors are included, and
 * each upload's parent folder is added automatically.
 */
export const buildFolderPlan = (folders: readonly string[], uploadPaths: readonly string[]): string[] => {
  const byLowerPath: Map<string, string> = new Map<string, string>();
  const addWithAncestors = (path: string): void => {
    const segments: string[] = splitPath(path);
    for (let depth = 1; depth <= segments.length; depth++) {
      const ancestor: string = segments.slice(0, depth).join('/');
      if (!byLowerPath.has(ancestor.toLowerCase())) {
        byLowerPath.set(ancestor.toLowerCase(), ancestor);
      }
    }
  };

  folders.forEach(addWithAncestors);
  uploadPaths.forEach((uploadPath: string) => { addWithAncestors(parentPathOf(uploadPath)); });

  return Array.from(byLowerPath.values()).sort(
    (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  );
};

export const buildFolderAbsoluteUrl = (siteUrl: string, libraryName: string, folderPath: string): string => {
  const site: URL = new URL(siteUrl);
  const sitePath: string = site.pathname.replace(/\/$/, '');
  const library: string = libraryName.split('/').map((segment: string) => encodeURIComponent(segment)).join('/');
  return `${site.origin}${sitePath}/${library}/${encodeGraphPath(folderPath)}`;
};
