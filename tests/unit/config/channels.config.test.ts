import { describe, expect, it } from 'vitest';
import {
  type WhatsAppPhoneConfig,
  validateChannelConsistency,
} from '../../../src/config/channels.config.js';
import { IdpError } from '../../../src/core/errors/IdpError.js';

function channelMap(
  entries: Array<[string, WhatsAppPhoneConfig]>,
): ReadonlyMap<string, WhatsAppPhoneConfig> {
  return new Map(entries);
}

function secretMap(platformIds: number[]): ReadonlyMap<number, string> {
  return new Map(platformIds.map((p) => [p, `secret-${p}`]));
}

describe('validateChannelConsistency', () => {
  it('passes for a well-formed dual map (staff + client per platform)', () => {
    const map = channelMap([
      ['pn-staff-1', { accessToken: 't', role: 'staff', platformId: 1 }],
      ['pn-client-1', { accessToken: 't', role: 'client', platformId: 1 }],
      ['pn-staff-2', { accessToken: 't', role: 'staff', platformId: 2 }],
      ['pn-client-2', { accessToken: 't', role: 'client', platformId: 2 }],
    ]);
    expect(() => validateChannelConsistency(map, secretMap([1, 2]), false)).not.toThrow();
  });

  it('throws when two phone_number_ids share the same (role, platformId)', () => {
    const map = channelMap([
      ['pn-a', { accessToken: 't', role: 'staff', platformId: 1 }],
      ['pn-b', { accessToken: 't', role: 'staff', platformId: 1 }],
    ]);
    expect(() => validateChannelConsistency(map, secretMap([1]), false)).toThrowError(IdpError);
    try {
      validateChannelConsistency(map, secretMap([1]), false);
    } catch (err) {
      expect(err).toBeInstanceOf(IdpError);
      expect((err as IdpError).code).toBe('invalid_env');
      expect((err as IdpError).message).toContain('duplicate');
      expect((err as IdpError).message).toContain('pn-a');
      expect((err as IdpError).message).toContain('pn-b');
    }
  });

  it('throws when a platformId in the channel map has no app_secret', () => {
    const map = channelMap([
      ['pn-staff-1', { accessToken: 't', role: 'staff', platformId: 1 }],
      ['pn-client-3', { accessToken: 't', role: 'client', platformId: 3 }],
    ]);
    // secret for platform 1 present, platform 3 missing.
    try {
      validateChannelConsistency(map, secretMap([1]), false);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IdpError);
      expect((err as IdpError).code).toBe('invalid_env');
      expect((err as IdpError).message).toContain('platform_id=3');
      expect((err as IdpError).message).toContain('pn-client-3');
    }
  });

  it('skips the app_secret coverage check when skipSignature=true (dev)', () => {
    const map = channelMap([['pn-staff-1', { accessToken: 't', role: 'staff', platformId: 1 }]]);
    // No secrets at all, but skipSignature bypasses coverage.
    expect(() => validateChannelConsistency(map, secretMap([]), true)).not.toThrow();
  });

  it('still enforces (role, platformId) uniqueness even when skipSignature=true', () => {
    const map = channelMap([
      ['pn-a', { accessToken: 't', role: 'client', platformId: 2 }],
      ['pn-b', { accessToken: 't', role: 'client', platformId: 2 }],
    ]);
    expect(() => validateChannelConsistency(map, secretMap([]), true)).toThrowError(IdpError);
  });

  it('passes trivially for an empty channel map', () => {
    expect(() => validateChannelConsistency(channelMap([]), secretMap([]), false)).not.toThrow();
  });
});
