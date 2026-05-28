import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
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

const SYSTEM_PROMPT =
  'Sos un agente de atención al cliente. El usuario acaba de cancelar un turno. Generá UN mensaje corto (máx 2 oraciones) confirmando la cancelación y ofreciendo reprogramar si quiere. NO inventes datos. NO menciones códigos.';

export function makeCancelSuccessNode(deps: CancelSuccessDeps) {
  const { llm, logger } = deps;

  return async function successResponse(state: {
    subgraphState?: unknown;
  }): Promise<Partial<CancelDraftState>> {
    const current = state.subgraphState as CancelDraftState | undefined;
    if (!current) return {};

    const displayName = current.slots.appointmentUuid?.displayName ?? 'tu turno';
    const userPrompt = `Turno cancelado: ${displayName}. Generá el mensaje al cliente.`;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 100,
      system: SYSTEM_PROMPT,
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
