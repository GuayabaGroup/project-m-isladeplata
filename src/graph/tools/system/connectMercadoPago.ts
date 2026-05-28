import type { Outcome } from '../../../core/types/Outcome.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude generar el link para conectar Mercado Pago. Probá de nuevo en un minuto.',
  },
};

export const connectMercadoPago: AtomicTool = {
  name: 'connect_mercado_pago',
  allowedRoles: ['staff'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const identity = state.identity;
    if (!identity?.profileUuid) {
      deps.logger.warn('connectMercadoPago: missing profileUuid in identity');
      return { outcome: ERROR_OUTCOME };
    }

    try {
      const result = await deps.guacuco.connectMercadoPago(identity);

      if (!result?.url) {
        deps.logger.warn('connectMercadoPago: empty URL from Guacuco');
        return { outcome: ERROR_OUTCOME };
      }

      const outcome: Outcome = {
        action: 'response',
        pendingReply: {
          cta: {
            text: 'Conectá tu cuenta de Mercado Pago acá:',
            url: result.url,
            displayText: 'Conectar',
          },
        },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('connectMercadoPago failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
