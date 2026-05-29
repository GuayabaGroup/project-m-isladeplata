import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import { buildPersona, toPersonaContext } from '../../../../config/personality/buildPersona.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import type { CancelDraftState } from '../state.js';

/**
 * Genera el mensaje del gate de cancelación (LLM Haiku, max 120 tokens).
 *
 * Anti-alucinación: recibe SOLO el `displayName` del appointment. Sin UUIDs.
 *
 * Idempotente: si ya hay `intentUuid + message`, no-op (sobrevive re-runs).
 */

export interface CancelBuildConfirmDeps {
  llm: LlmProvider;
  logger: Logger;
}

const TASK_PROMPT =
  'El usuario quiere CANCELAR un turno. Generá UN mensaje (máx 2 oraciones) confirmando explícitamente la cancelación. Tono cuidadoso (es una acción destructiva). Terminá con "¿Cancelo?" o equivalente. NO inventes datos.';

const FALLBACK_TEMPLATE = (displayName: string) =>
  `Voy a cancelar: ${displayName}. ¿Confirmás la cancelación?`;

export function makeCancelBuildConfirmMessageNode(deps: CancelBuildConfirmDeps) {
  const { llm, logger } = deps;

  return async function buildConfirm(state: {
    identity?: Identity;
    subgraphState?: unknown;
  }): Promise<Partial<CancelDraftState>> {
    const current = state.subgraphState as CancelDraftState | undefined;
    if (!current) return {};

    if (current.confirmation.intentUuid && current.confirmation.message) {
      logger.debug('cancel.buildConfirm: cached, skipping LLM');
      return {};
    }

    const slot = current.slots.appointmentUuid;
    if (slot.status !== 'resolved') {
      logger.warn('cancel.buildConfirm: slot not resolved, cannot build');
      return {};
    }
    const displayName = slot.displayName ?? 'tu turno';

    const userPrompt = `Turno a cancelar: ${displayName}.\n\nGenerá el mensaje de confirmación.`;

    const persona = state.identity ? buildPersona(toPersonaContext(state.identity)) : '';
    const system = persona ? `${persona}\n\n${TASK_PROMPT}` : TASK_PROMPT;

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      maxTokens: 120,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const message = response.text.length > 0 ? response.text : FALLBACK_TEMPLATE(displayName);
    const intentUuid = randomUUID();

    return {
      confirmation: {
        intentUuid,
        message,
        requestedAt: new Date().toISOString(),
      },
      phase: 'awaiting_confirmation',
    };
  };
}
