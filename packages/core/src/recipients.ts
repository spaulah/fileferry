export interface ParsedRecipients {
  valid: string[];
  invalid: string[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parses free-form recipient input separated by commas, semicolons or newlines.
 * Addresses are lowercased and de-duplicated. Anything that does not look like an
 * email address is returned in `invalid` so the caller can show it to the user.
 */
export const parseRecipients = (raw: string): ParsedRecipients => {
  const tokens: string[] = raw
    .split(/[;,\n]+/)
    .map((token: string) => token.trim().toLowerCase())
    .filter((token: string) => token.length > 0);

  const result: ParsedRecipients = { valid: [], invalid: [] };
  for (const token of new Set(tokens)) {
    if (EMAIL_PATTERN.test(token)) {
      result.valid.push(token);
    } else {
      result.invalid.push(token);
    }
  }

  return result;
};
