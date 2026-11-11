// Turns what a user dropped or picked into files and folders that keep their relative
// structure. Browsers hand folder contents over in several batches, and a folder's
// emptiness is only visible through the directory API, so both cases are handled here.

export interface SelectedFile {
  file: File;
  /** Forward-slash path relative to the selection root, e.g. "Subpoena/Exhibits/a.pdf". */
  relativePath: string;
}

export interface FileSelection {
  files: SelectedFile[];
  /** Every selected folder as a relative path, including empty ones. */
  folders: string[];
}

export const EMPTY_SELECTION: FileSelection = { files: [], folders: [] };

const IGNORED_NAMES: readonly string[] = ['thumbs.db', 'ehthumbs.db', 'desktop.ini', '__macosx'];

/** OS metadata (.DS_Store, ._ resource forks, Thumbs.db, desktop.ini), Office lock files
 *  (~$...) and any other hidden, dot-prefixed item are never shared. */
export const isIgnoredName = (name: string): boolean => {
  const lowerName: string = name.toLowerCase();
  return lowerName.startsWith('.') || lowerName.startsWith('~$') || IGNORED_NAMES.includes(lowerName);
};

const readEntryBatch = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => { reader.readEntries(resolve, reject); });

const readAllEntries = async (directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
  const reader: FileSystemDirectoryReader = directory.createReader();
  const entries: FileSystemEntry[] = [];

  // readEntries returns results in batches (100 at a time in Chrome); an empty batch
  // marks the end of the directory.
  for (let batch = await readEntryBatch(reader); batch.length > 0; batch = await readEntryBatch(reader)) {
    entries.push(...batch);
  }

  return entries;
};

const readFile = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => { entry.file(resolve, reject); });

const collectEntry = async (entry: FileSystemEntry, parentPath: string, selection: FileSelection): Promise<void> => {
  if (isIgnoredName(entry.name)) {
    return;
  }

  const path: string = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    selection.files.push({ file: await readFile(entry as FileSystemFileEntry), relativePath: path });
    return;
  }

  if (entry.isDirectory) {
    selection.folders.push(path);
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await collectEntry(child, path, selection);
    }
  }
};

/**
 * Walks drag-and-drop entries. Call this synchronously inside the drop handler, with
 * `dataTransfer.items[i].webkitGetAsEntry()` results: the browser clears the
 * DataTransfer once the handler returns, but walking the entries can continue async.
 */
export const collectFromEntries = async (entries: FileSystemEntry[]): Promise<FileSelection> => {
  const selection: FileSelection = { files: [], folders: [] };
  for (const entry of entries) {
    await collectEntry(entry, '', selection);
  }
  return selection;
};

/**
 * Handles `<input type="file">` selections. With `webkitdirectory`, each file carries
 * `webkitRelativePath`. The browser does not report empty folders in that mode, so a
 * folder appears only when it contains a file.
 */
export const collectFromFileList = (files: File[]): FileSelection => {
  const selection: FileSelection = { files: [], folders: [] };
  const folders: Set<string> = new Set<string>();

  for (const file of files) {
    const relativePath: string = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const segments: string[] = relativePath.split('/');
    if (segments.some(isIgnoredName)) {
      continue;
    }

    selection.files.push({ file, relativePath });
    for (let depth = 1; depth < segments.length; depth++) {
      folders.add(segments.slice(0, depth).join('/'));
    }
  }

  selection.folders = Array.from(folders);
  return selection;
};

/** Merges two selections. SharePoint paths are case-insensitive, so names that differ
 *  only by case collapse into one item and the later one wins. */
export const mergeSelections = (existing: FileSelection, incoming: FileSelection): FileSelection => {
  const filesByPath: Map<string, SelectedFile> = new Map<string, SelectedFile>();
  for (const item of [...existing.files, ...incoming.files]) {
    filesByPath.set(item.relativePath.toLowerCase(), item);
  }

  const foldersByPath: Map<string, string> = new Map<string, string>();
  for (const folder of [...existing.folders, ...incoming.folders]) {
    foldersByPath.set(folder.toLowerCase(), folder);
  }

  return { files: Array.from(filesByPath.values()), folders: Array.from(foldersByPath.values()) };
};
