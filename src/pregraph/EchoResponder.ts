import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import { sanitizeUserInput } from '../security/sanitize.js';

/**
 * H2 placeholder: produces a deterministic echo `Outcome`. In H3 this is
 * replaced by the LangGraph supervisor invoke.
 *
 * Exists so the end-to-end webhook → identity → sender flow can be exercised
 * before the graph is in place.
 */
export class EchoResponder {
  build(rawText: string, identity: Identity): Outcome {
    const sanitized = sanitizeUserInput(rawText);
    const roleLabel = identity.profileType === 'staff' ? 'staff' : 'cliente';
    const greeting =
      sanitized.length > 0
        ? `Recibido (${roleLabel}): "${sanitized}"`
        : `Recibido (${roleLabel}): [mensaje vacío o no textual]`;
    return {
      action: 'response',
      pendingReply: { text: greeting },
    };
  }
}

/**
 * Build a welcome `Outcome` for a freshly auto-onboarded staff user. Uses
 * the welcomeMessage + onboardingUrl that Guacuco already produced for us
 * (no LLM involvement).
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
