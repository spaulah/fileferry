import { describe, expect, it } from 'vitest';
import {
  collectFromEntries,
  collectFromFileList,
  isIgnoredName,
  mergeSelections,
  type FileSelection
} from '../src/index.js';

const fakeFile = (name: string, webkitRelativePath = ''): File =>
  ({ name, webkitRelativePath, size: 1 } as unknown as File);

const fileEntry = (name: string): FileSystemEntry =>
  ({
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => { resolve(fakeFile(name)); }
  } as unknown as FileSystemEntry);

// Returns children in batches of `batchSize`, then an empty batch, as Chrome does.
const directoryEntry = (name: string, children: FileSystemEntry[], batchSize = 100): FileSystemEntry =>
  ({
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          const batch = children.slice(offset, offset + batchSize);
          offset += batchSize;
          resolve(batch);
        }
      };
    }
  } as unknown as FileSystemEntry);

const paths = (selection: FileSelection): string[] => selection.files.map((item) => item.relativePath).sort();

describe('isIgnoredName', () => {
  it.each(['.DS_Store', '._Report.pdf', 'Thumbs.db', 'DESKTOP.INI', '~$Brief.docx', '__MACOSX', '.git'])('ignores %s', (name) => { expect(isIgnoredName(name)).toBe(true); }
  );

  it.each(['Brief.docx', 'Exhibit ~3.pdf', 'Thumbs.db.pdf'])('keeps %s', (name) => { expect(isIgnoredName(name)).toBe(false); });
});

describe('collectFromEntries', () => {
  it('keeps nested structure and records every folder, including empty ones', async () => {
    const selection = await collectFromEntries([
      fileEntry('loose.pdf'),
      directoryEntry('Subpoena', [
        fileEntry('response.pdf'),
        directoryEntry('Exhibits', [fileEntry('a.pdf')]),
        directoryEntry('Empty', [])
      ])
    ]);

    expect(paths(selection)).toEqual(['Subpoena/Exhibits/a.pdf', 'Subpoena/response.pdf', 'loose.pdf']);
    expect(selection.folders.sort()).toEqual(['Subpoena', 'Subpoena/Empty', 'Subpoena/Exhibits']);
  });

  it('reads directories that return entries in several batches', async () => {
    const children = Array.from({ length: 5 }, (_, index) => fileEntry(`f${index}.pdf`));
    const selection = await collectFromEntries([directoryEntry('Big', children, 2)]);

    expect(selection.files).toHaveLength(5);
  });

  it('skips system and temporary files and folders', async () => {
    const selection = await collectFromEntries([
      directoryEntry('Case', [
        fileEntry('.DS_Store'),
        fileEntry('~$Brief.docx'),
        fileEntry('Brief.docx'),
        directoryEntry('__MACOSX', [fileEntry('._Brief.docx')])
      ])
    ]);

    expect(paths(selection)).toEqual(['Case/Brief.docx']);
    expect(selection.folders).toEqual(['Case']);
  });
});

describe('collectFromFileList', () => {
  it('derives folders from webkitRelativePath and skips ignored items', () => {
    const selection = collectFromFileList([
      fakeFile('a.pdf', 'Case/Client/a.pdf'),
      fakeFile('.DS_Store', 'Case/.DS_Store'),
      fakeFile('b.pdf', 'Case/Client/Deep/b.pdf')
    ]);

    expect(paths(selection)).toEqual(['Case/Client/Deep/b.pdf', 'Case/Client/a.pdf']);
    expect(selection.folders.sort()).toEqual(['Case', 'Case/Client', 'Case/Client/Deep']);
  });

  it('uses the file name for loose files', () => {
    expect(paths(collectFromFileList([fakeFile('loose.pdf')]))).toEqual(['loose.pdf']);
  });
});

describe('mergeSelections', () => {
  it('lets a later file win when names differ only by case', () => {
    const merged = mergeSelections(
      { files: [{ file: fakeFile('A.pdf'), relativePath: 'Docs/A.pdf' }], folders: ['Docs'] },
      { files: [{ file: fakeFile('a.pdf'), relativePath: 'docs/a.pdf' }], folders: ['DOCS', 'Other'] }
    );

    expect(merged.files.map((item) => item.relativePath)).toEqual(['docs/a.pdf']);
    expect(merged.folders).toEqual(['DOCS', 'Other']);
  });
});
