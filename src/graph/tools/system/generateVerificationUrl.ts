import type { Outcome } from '../../../core/types/Outcome.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

interface VerificationUrlResult {
  url: string;
}

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude generar tu link de verificación en este momento. Probá de nuevo en un minuto.',
  },
};

export const generateVerificationUrl: AtomicTool = {
  name: 'generate_verification_url',
  allowedRoles: ['client', 'staff'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const profileUuid = state.identity?.profileUuid;
    if (!profileUuid) {
      deps.logger.warn('generateVerificationUrl: missing profileUuid in identity');
      return { outcome: ERROR_OUTCOME };
    }

    try {
      const result = await deps.guacuco.executeTool<VerificationUrlResult>(
        'generate_verification_url',
        {},
        { context: { profile_uuid: profileUuid } },
      );

      if (!result?.url) {
        deps.logger.warn('generateVerificationUrl: empty URL from Guacuco');
        return { outcome: ERROR_OUTCOME };
      }

      const outcome: Outcome = {
        action: 'response',
        pendingReply: {
          cta: {
            text: 'Acá tenés tu link para verificar tu cuenta:',
            url: result.url,
            displayText: 'Verificar',
          },
        },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('generateVerificationUrl failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
