import { describe, expect, it } from 'vitest';
import type { Identity } from '../../../src/core/types/Identity.js';
import { EchoResponder, buildWelcomeOutcome } from '../../../src/pregraph/EchoResponder.js';

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia',
  profileUuid: 'prof-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

describe('EchoResponder.build', () => {
  it('builds an echo response with sanitized text', () => {
    const r = new EchoResponder();
    const outcome = r.build('  hola <script>alert(1)</script>   ', IDENTITY);
    expect(outcome.action).toBe('response');
    expect(outcome.pendingReply?.text).toContain('cliente');
    expect(outcome.pendingReply?.text).not.toContain('<script>');
  });

  it('handles empty text gracefully', () => {
    const r = new EchoResponder();
    const outcome = r.build('', IDENTITY);
    expect(outcome.pendingReply?.text).toContain('vacío');
  });

  it('uses staff label when profileType=staff', () => {
    const r = new EchoResponder();
    const outcome = r.build('hola', { ...IDENTITY, profileType: 'staff' });
    expect(outcome.pendingReply?.text).toContain('staff');
  });
});

describe('buildWelcomeOutcome', () => {
  it('includes cta when onboardingUrl present', () => {
    const outcome = buildWelcomeOutcome('Bienvenido Juan', 'https://onboard.example/abc');
    expect(outcome.action).toBe('response');
    expect(outcome.pendingReply?.cta).toEqual({
      text: 'Bienvenido Juan',
      url: 'https://onboard.example/abc',
      displayText: 'Comenzar',
    });
  });

  it('falls back to plain text when no onboardingUrl', () => {
    const outcome = buildWelcomeOutcome('Bienvenido Juan', null);
    expect(outcome.pendingReply?.text).toBe('Bienvenido Juan');
    expect(outcome.pendingReply?.cta).toBeUndefined();
  });

  it('uses default greeting when welcomeMessage is null', () => {
    const outcome = buildWelcomeOutcome(null, null);
    expect(outcome.pendingReply?.text).toContain('Bienvenido');
  });
});
