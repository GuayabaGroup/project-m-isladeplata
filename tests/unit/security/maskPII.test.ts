import { describe, expect, it } from 'vitest';
import { maskPII } from '../../../src/security/maskPII.js';

describe('maskPII', () => {
  it('returns empty string for non-string input', () => {
    expect(maskPII(null)).toBe('');
    expect(maskPII(undefined)).toBe('');
    expect(maskPII(123)).toBe('');
    expect(maskPII('')).toBe('');
  });

  it('masks email local part but preserves domain', () => {
    expect(maskPII('mi mail es juan.perez@gmail.com gracias')).toBe(
      'mi mail es ju***@gmail.com gracias',
    );
  });

  it('masks Argentinian phone with country code', () => {
    const out = maskPII('mi número es +54 9 11 1234 5678 ok');
    expect(out).not.toContain('1234 5678');
    expect(out).toContain('***78');
  });

  it('masks bare 10-digit phone', () => {
    expect(maskPII('llamame al 1123456789')).toBe('llamame al ***89');
  });

  it('does not touch short numeric tokens (codes, IDs)', () => {
    expect(maskPII('código 4321 expira en 5 min')).toBe('código 4321 expira en 5 min');
  });

  it('masks both phone and email in same string', () => {
    const out = maskPII('cliente test@example.com tel 1123456789');
    expect(out).toContain('te***@example.com');
    expect(out).toContain('***89');
    expect(out).not.toContain('test@example.com');
    expect(out).not.toContain('1123456789');
  });
});
