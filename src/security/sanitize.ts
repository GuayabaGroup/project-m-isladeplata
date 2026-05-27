const MAX_INPUT_LENGTH = 10_000;
const HTML_TAG_RE = /<[^>]*>/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Sanitize text before sending it to the LLM. Mandatory for any user-provided
 * content (§13 REGLAS_ISLADEPLATA).
 *
 * - Truncates to 10,000 chars (prevents prompt-bombing).
 * - Strips HTML tags (no markup injection).
 * - Normalizes whitespace (collapses runs, trims).
 *
 * Returns empty string for null/undefined/non-string input.
 */
export function sanitizeUserInput(input: unknown): string {
  if (typeof input !== 'string') return '';
  const truncated = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;
  return truncated.replace(HTML_TAG_RE, '').replace(WHITESPACE_RE, ' ').trim();
}
