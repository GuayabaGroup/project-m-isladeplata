import { describe, expect, it } from 'vitest';
import { buildWelcomeOutcome } from '../../../src/pregraph/welcomeFlow.js';

describe('buildWelcomeOutcome', () => {
  it('includes cta when onboardingUrl present', () => {
    const outcome = buildWelcomeOutcome('Bienvenido Juan', 'https://onboard.example/abc', 1);
    expect(outcome.action).toBe('response');
    expect(outcome.pendingReply?.cta).toEqual({
      text: 'Bienvenido Juan',
      url: 'https://onboard.example/abc',
      displayText: 'Acceder a mi cuenta',
    });
  });

  it('falls back to plain text when no onboardingUrl', () => {
    const outcome = buildWelcomeOutcome('Bienvenido Juan', null, 1);
    expect(outcome.pendingReply?.text).toBe('Bienvenido Juan');
    expect(outcome.pendingReply?.cta).toBeUndefined();
  });

  it('uses brand fallback resolved by platformId when welcomeMessage is null', () => {
    expect(buildWelcomeOutcome(null, null, 2).pendingReply?.text).toBe('Bienvenido/a a Groomia');
    expect(buildWelcomeOutcome(null, null, 3).pendingReply?.text).toBe('Bienvenido/a a Divapp');
  });

  it('defaults brand to Allia when platformId is unknown or null', () => {
    expect(buildWelcomeOutcome(null, null, null).pendingReply?.text).toBe('Bienvenido/a a Allia');
    expect(buildWelcomeOutcome(null, null, 99).pendingReply?.text).toBe('Bienvenido/a a Allia');
  });
});
