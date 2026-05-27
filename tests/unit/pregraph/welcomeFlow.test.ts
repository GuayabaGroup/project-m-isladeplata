import { describe, expect, it } from 'vitest';
import { buildWelcomeOutcome } from '../../../src/pregraph/welcomeFlow.js';

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
