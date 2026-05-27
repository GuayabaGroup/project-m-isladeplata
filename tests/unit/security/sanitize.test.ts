import { describe, expect, it } from 'vitest';
import { sanitizeUserInput } from '../../../src/security/sanitize.js';

describe('sanitizeUserInput', () => {
  it('strips HTML tags', () => {
    expect(sanitizeUserInput('hola <script>alert(1)</script> mundo')).toBe('hola alert(1) mundo');
  });

  it('normalizes whitespace', () => {
    expect(sanitizeUserInput('  hola    mundo  ')).toBe('hola mundo');
  });

  it('truncates at 10000 chars', () => {
    const long = 'a'.repeat(15_000);
    const result = sanitizeUserInput(long);
    expect(result.length).toBe(10_000);
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeUserInput(null)).toBe('');
    expect(sanitizeUserInput(undefined)).toBe('');
    expect(sanitizeUserInput(42)).toBe('');
    expect(sanitizeUserInput({})).toBe('');
  });

  it('preserves text content of stripped tags', () => {
    expect(sanitizeUserInput('<b>negrita</b>')).toBe('negrita');
  });

  it('handles empty string', () => {
    expect(sanitizeUserInput('')).toBe('');
  });
});
