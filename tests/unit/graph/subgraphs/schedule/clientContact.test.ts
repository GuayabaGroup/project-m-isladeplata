import { describe, expect, it } from 'vitest';
import { parseClientContact } from '../../../../../src/graph/subgraphs/schedule/clientContact.js';

describe('parseClientContact', () => {
  it('extracts name + phone with leading "+"', () => {
    expect(parseClientContact('juan +5491134498081')).toEqual({
      phone: '+5491134498081',
      name: 'juan',
    });
  });

  it('extracts name + bare-digit phone', () => {
    expect(parseClientContact('Juan 1134498081')).toEqual({
      phone: '1134498081',
      name: 'Juan',
    });
  });

  it('extracts phone with no name', () => {
    expect(parseClientContact('5491134498081')).toEqual({
      phone: '5491134498081',
      name: null,
    });
  });

  it('handles separators inside the phone (spaces, dashes, parens)', () => {
    const result = parseClientContact('Maria (11) 3449-8081');
    expect(result.name).toBe('Maria');
    expect(result.phone?.replace(/\D/g, '')).toBe('1134498081');
  });

  it('returns null phone when there is no phone-like token', () => {
    expect(parseClientContact('Juan Perez')).toEqual({ phone: null, name: null });
  });

  it('returns null phone when digits are too few', () => {
    expect(parseClientContact('turno 12345')).toEqual({ phone: null, name: null });
  });

  it('returns null phone for empty text', () => {
    expect(parseClientContact('   ')).toEqual({ phone: null, name: null });
  });
});
