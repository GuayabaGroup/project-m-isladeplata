import type { Outcome } from '../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../security/sanitize.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude reenviar tu mensaje al negocio. Probá de nuevo en un minuto.',
  },
};

const EMPTY_OUTCOME: Outcome = {
  action: 'ignored',
};

/**
 * Reenvía el mensaje del usuario al negocio (ej: "estoy en la puerta",
 * "llego tarde"). En H3.B SIN gate de confirmación interactiva — decisión §7
 * PLAN_H3B: simple, agregar gate en H5 cuando el patrón esté validado en H4.
 */
export const forwardMessage: AtomicTool = {
  name: 'forward_message',
  allowedRoles: ['client', 'staff'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const identity = state.identity;
    const rawText = state.input?.channelMessage?.contentText ?? '';
    const cleanText = sanitizeUserInput(rawText);

    if (!identity?.tenantAlliaId || !identity?.profileUuid) {
      deps.logger.warn('forwardMessage: missing identity fields');
      return { outcome: ERROR_OUTCOME };
    }
    if (cleanText.length === 0) {
      deps.logger.debug('forwardMessage: empty message, nothing to forward');
      return { outcome: EMPTY_OUTCOME };
    }

    try {
      await deps.guacuco.forwardMessage(cleanText, identity);

      const outcome: Outcome = {
        action: 'response',
        pendingReply: {
          text: 'Listo, tu mensaje fue enviado al negocio. Te van a contactar a la brevedad.',
        },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('forwardMessage failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
