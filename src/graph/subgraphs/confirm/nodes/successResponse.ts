import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import { buildPersona, toPersonaContext } from '../../../../config/personality/buildPersona.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import type { ConfirmDraftState } from '../state.js';

/**
 * Genera el mensaje de éxito post-confirm. LLM Haiku corto. Recibe SOLO el
 * `displayName` del appointment (descripción legible).
 */

export interface ConfirmSuccessDeps {
  llm: LlmProvider;
  logger: Logger;
}

const TASK_PROMPT =
  'El usuario acaba de confirmar un turno. Generá UN mensaje corto (máx 1-2 oraciones) confirmando que está confirmado. NO inventes datos. NO menciones códigos.';

export function makeConfirmSuccessNode(deps: ConfirmSuccessDeps) {
  const { llm, logger } = deps;

  return async function successResponse(state: {
    identity?: Identity;
    subgraphState?: unknown;
  }): Promise<Partial<ConfirmDraftState>> {
    const current = state.subgraphState as ConfirmDraftState | undefined;
    if (!current) return {};

    const displayName = current.slots.appointmentUuid?.displayName ?? 'tu turno';
    const userPrompt = `Turno confirmado: ${displayName}. Generá el mensaje al cliente.`;

    const persona = state.identity ? buildPersona(toPersonaContext(state.identity)) : '';
    const system = persona ? `${persona}\n\n${TASK_PROMPT}` : TASK_PROMPT;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 100,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text =
      response.text.length > 0 ? response.text : `Listo, confirmé ${displayName}. ¡Te esperamos!`;

    logger.debug('confirm.successResponse', {
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
