import { describe, expect, it } from 'vitest';
import {
  assertPathLengths,
  buildCaseFolderName,
  buildFolderAbsoluteUrl,
  buildFolderPlan,
  encodeGraphPath,
  normalizePathSegment,
  normalizeRelativePath
} from '../src/index.js';

describe('normalizePathSegment', () => {
  it('replaces reserved characters with a hyphen and collapses runs', () => {
    expect(normalizePathSegment('file*name')).toBe('file-name');
    expect(normalizePathSegment('foo/bar')).toBe('foo-bar');
    expect(normalizePathSegment('foo**bar')).toBe('foo-bar');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizePathSegment('  hello   world  ')).toBe('hello world');
  });

  it('leaves a clean name unchanged', () => {
    expect(normalizePathSegment('Smith v Jones 2024')).toBe('Smith v Jones 2024');
  });
});

describe('normalizeRelativePath', () => {
  it('normalizes each segment and drops empty ones', () => {
    expect(normalizeRelativePath('Exhibits/ /A:B//C')).toBe('Exhibits/A-B/C');
  });
});

describe('buildCaseFolderName', () => {
  it('uses the title alone when the number matches it', () => {
    expect(buildCaseFolderName('Smith v. Jones', 'Smith v. Jones')).toBe('Smith v. Jones');
  });

  it('combines number and title when both are present and different', () => {
    expect(buildCaseFolderName('2024-001', 'Smith v. Jones')).toBe('2024-001 - Smith v. Jones');
  });

  it('falls back to whichever part is present', () => {
    expect(buildCaseFolderName(undefined, 'Smith v. Jones')).toBe('Smith v. Jones');
    expect(buildCaseFolderName('2024-001', '')).toBe('2024-001');
  });
});

describe('encodeGraphPath', () => {
  it('encodes each segment and keeps the separators', () => {
    expect(encodeGraphPath('Case A/Opposing Counsel')).toBe('Case%20A/Opposing%20Counsel');
  });
});

describe('buildFolderPlan', () => {
  it('orders parents before children and removes case-insensitive duplicates', () => {
    const plan = buildFolderPlan(['Case', 'Case/Client', 'Case/client/Deep/Er'], ['Case/Client/Deep/a.pdf', 'Case/CLIENT/b.pdf']);

    expect(plan).toEqual(['Case', 'Case/Client', 'Case/client/Deep', 'Case/client/Deep/Er']);
  });

  it('adds the parent of each upload', () => {
    expect(buildFolderPlan(['Case'], ['Case/Sub/x.pdf'])).toEqual(['Case', 'Case/Sub']);
  });

  it('adds missing ancestors of a selected folder', () => {
    expect(buildFolderPlan(['Case/A/B'], [])).toEqual(['Case', 'Case/A', 'Case/A/B']);
  });
});

describe('assertPathLengths', () => {
  it('passes when every path fits', () => {
    expect(() => { assertPathLengths('/sites/legal/Docs', ['Case/a.pdf'], 400); }).not.toThrow();
  });

  it('names every path that is too long and throws before anything is created', () => {
    const long = 'x'.repeat(120);
    expect(() => { assertPathLengths('/sites/legal/Docs', [`Case/${long}`, 'Case/ok'], 100); }).toThrow(/Nothing was uploaded/);
  });
});

describe('buildFolderAbsoluteUrl', () => {
  it('builds the library URL with encoded segments', () => {
    expect(buildFolderAbsoluteUrl('https://contoso.sharepoint.com/sites/legal', 'Shared Documents', 'Case A/Client')).toBe(
      'https://contoso.sharepoint.com/sites/legal/Shared%20Documents/Case%20A/Client'
    );
  });
});
