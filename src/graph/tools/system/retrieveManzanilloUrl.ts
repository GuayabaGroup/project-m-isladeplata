import type { Outcome } from '../../../core/types/Outcome.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude generar tu link de reservas en este momento. Probá de nuevo en un minuto.',
  },
};

export const retrieveManzanilloUrl: AtomicTool = {
  name: 'retrieve_manzanillo_url',
  allowedRoles: ['client'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const identity = state.identity;
    if (!identity?.tenantAlliaId) {
      deps.logger.warn('retrieveManzanilloUrl: missing tenantAlliaId in identity');
      return { outcome: ERROR_OUTCOME };
    }

    try {
      const result = await deps.guacuco.retrieveManzanilloUrl(identity);

      if (!result?.url) {
        deps.logger.warn('retrieveManzanilloUrl: empty URL from Guacuco');
        return { outcome: ERROR_OUTCOME };
      }

      const outcome: Outcome = {
        action: 'response',
        pendingReply: {
          cta: { text: 'Acá tenés tu link de reservas:', url: result.url, displayText: 'Abrir' },
        },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('retrieveManzanilloUrl failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
