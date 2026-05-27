import type { Outcome } from '../core/types/Outcome.js';

/**
 * Build a welcome `Outcome` for a freshly auto-onboarded staff user.
 * Uses the welcomeMessage + onboardingUrl that Guacuco already produced
 * (no LLM involvement).
 *
 * Lives outside the graph because the welcome flow is determinístico
 * y se dispara cuando `isNewUser=true` en el pre-grafo, antes del invoke
 * al grafo compilado (§7.2 REGLAS_ISLADEPLATA).
 */
export function buildWelcomeOutcome(
  welcomeMessage: string | null,
  onboardingUrl: string | null,
): Outcome {
  const text = welcomeMessage ?? 'Bienvenido/a a Isla de Plata.';
  if (onboardingUrl) {
    return {
      action: 'response',
      pendingReply: {
        cta: { text, url: onboardingUrl, displayText: 'Comenzar' },
      },
    };
  }
  return { action: 'response', pendingReply: { text } };
}
