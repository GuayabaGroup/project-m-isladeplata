import { resolvePlatformBrand } from '../config/platformBrand.js';
import type { Outcome } from '../core/types/Outcome.js';

/**
 * Build a welcome `Outcome` for a freshly auto-onboarded staff user.
 * Uses the welcomeMessage + onboardingUrl that Guacuco already produced
 * (no LLM involvement). Cuando `welcomeMessage` es `null`, cae al fallback
 * `'Bienvenido/a a {brand}'` resolviendo la marca por `platformId`
 * (§7.2 REGLAS_ISLADEPLATA) vía `resolvePlatformBrand`.
 *
 * El CTA usa el display text `'Acceder a mi cuenta'` (paridad con el flujo de
 * onboarding del IDP legacy).
 *
 * Lives outside the graph because the welcome flow is determinístico
 * y se dispara cuando `isNewUser=true` en el pre-grafo, antes del invoke
 * al grafo compilado (§7.2 REGLAS_ISLADEPLATA).
 */
export function buildWelcomeOutcome(
  welcomeMessage: string | null,
  onboardingUrl: string | null,
  platformId: number | null,
): Outcome {
  const text = welcomeMessage ?? `Bienvenido/a a ${resolvePlatformBrand(platformId)}`;
  if (onboardingUrl) {
    return {
      action: 'response',
      pendingReply: {
        cta: { text, url: onboardingUrl, displayText: 'Acceder a mi cuenta' },
      },
    };
  }
  return { action: 'response', pendingReply: { text } };
}
