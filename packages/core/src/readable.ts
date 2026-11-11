import { ValidationError } from './errors.js';

/**
 * In a browser, a file that cannot be read (a dropped folder, a file locked by another
 * program, or an un-downloaded cloud placeholder) fails its upload with the same
 * "Failed to fetch" as a network error, and retrying never helps. Reading one byte
 * from each file up front reports these before anything is created remotely.
 */
export const assertReadable = async (items: { label: string; file: Blob }[]): Promise<void> => {
  const unreadable: string[] = [];

  for (const { label, file } of items) {
    try {
      await (file.size > 0 ? file.slice(0, 1) : file).arrayBuffer();
    } catch {
      unreadable.push(`"${label}"`);
    }
  }

  if (unreadable.length > 0) {
    throw new ValidationError(
      `These files could not be read from this computer: ${unreadable.join(', ')}. ` +
        'Each one may be a folder rather than a file, open or locked in another program, ' +
        'or a cloud file that has not been downloaded. Remove it, close it or save a local copy, then add it again. Nothing was uploaded.'
    );
  }
};
