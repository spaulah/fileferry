import { describe, expect, it } from 'vitest';
import { parseRecipients } from '../src/index.js';

describe('parseRecipients', () => {
  it('returns empty lists for blank input', () => {
    expect(parseRecipients('')).toEqual({ valid: [], invalid: [] });
  });

  it.each([
    ['comma-separated', 'a@b.com, c@d.org'],
    ['semicolon-separated', 'a@b.com;c@d.org'],
    ['newline-separated', 'a@b.com\nc@d.org']
  ])('splits %s addresses', (_label: string, raw: string) => {
    expect(parseRecipients(raw).valid).toEqual(['a@b.com', 'c@d.org']);
  });

  it('separates valid and invalid tokens', () => {
    expect(parseRecipients('a@b.com, notanemail, c@d.org')).toEqual({
      valid: ['a@b.com', 'c@d.org'],
      invalid: ['notanemail']
    });
  });

  it('lowercases and de-duplicates', () => {
    expect(parseRecipients('User@Example.COM, user@example.com').valid).toEqual(['user@example.com']);
  });

  it('ignores empty tokens between separators', () => {
    expect(parseRecipients('a@b.com,,;c@d.org').valid).toEqual(['a@b.com', 'c@d.org']);
  });
});
