import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import { buildPersona, toPersonaContext } from '../../../../config/personality/buildPersona.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import type { CancelDraftState } from '../state.js';

/**
 * Mensaje de éxito post-cancel. LLM Haiku corto. Recibe SOLO el displayName
 * del appointment. Sugiere reprogramar como opción amable.
 */

export interface CancelSuccessDeps {
  llm: LlmProvider;
  logger: Logger;
}

const TASK_PROMPT =
  'El usuario acaba de cancelar un turno. Generá UN mensaje corto (máx 2 oraciones) confirmando la cancelación y ofreciendo reprogramar si quiere. NO inventes datos. NO menciones códigos.';

export function makeCancelSuccessNode(deps: CancelSuccessDeps) {
  const { llm, logger } = deps;

  return async function successResponse(state: {
    identity?: Identity;
    subgraphState?: unknown;
  }): Promise<Partial<CancelDraftState>> {
    const current = state.subgraphState as CancelDraftState | undefined;
    if (!current) return {};

    const displayName = current.slots.appointmentUuid?.displayName ?? 'tu turno';
    const userPrompt = `Turno cancelado: ${displayName}. Generá el mensaje al cliente.`;

    const persona = state.identity ? buildPersona(toPersonaContext(state.identity)) : '';
    const system = persona ? `${persona}\n\n${TASK_PROMPT}` : TASK_PROMPT;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 100,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text =
      response.text.length > 0
        ? response.text
        : `Listo, cancelé ${displayName}. Si querés reprogramar, decímelo.`;

    logger.debug('cancel.successResponse', {
      length: text.length,
      fallback: response.text.length === 0,
    });

    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text },
    };
    return { terminalOutcome };
  };
}
