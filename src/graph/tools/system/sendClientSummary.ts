import type { Outcome } from '../../../core/types/Outcome.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import { isToolAllowed } from '../../supervisor/filterTools.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude obtener el resumen del cliente en este momento. Probá de nuevo en un minuto.',
  },
};

const NOT_FOUND_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No pude identificar la cita de ese recordatorio. Abrí la notificación y volvé a tocar el botón.',
  },
};

const FORBIDDEN_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No tenés permiso para ver el resumen del cliente.',
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve la referencia de cita a mandar a Guacuco. El `supervisorEntryNode`
 * pisa `buttonShortcut.value` con el `appointmentUuid` real cuando logra cruzar
 * el `contextMessageId` del tap contra `recentTemplates`. Si NO lo resolvió
 * (template fuera de la ventana reciente), `value` queda como el título estático
 * del botón → caemos al `contextMessageId` (wamid) crudo, que Guacuco resuelve
 * vía `template_send_log` (mismo comportamiento que el IDP legacy). Devuelve
 * `null` si no hay ninguna referencia utilizable.
 */
function resolveAppointmentRef(state: GraphState): string | null {
  const value = state.routing?.buttonShortcut?.value;
  if (typeof value === 'string' && UUID_RE.test(value)) return value;
  return state.input?.channelMessage?.templateButton?.contextMessageId ?? null;
}

/**
 * Resumen del cliente dueño de una cita. Tool atómica single-turn disparada SOLO
 * por el tap del botón de quick-reply "Resumen del cliente" de los templates de
 * notificación (no hay path por texto libre). El supervisor la rutea desde el
 * `supervisorEntryRouter` cuando detecta `buttonShortcut.kind === 'client_summary'`.
 *
 * Fail-safe (§9.4): ante referencia faltante, rol no permitido o fallo del
 * backend, produce un outcome neutro — nunca lanza.
 */
export const sendClientSummary: AtomicTool = {
  name: 'send_client_summary',
  allowedRoles: ['staff'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const identity = state.identity;
    if (!identity?.profileUuid || !identity?.tenantUuid) {
      deps.logger.warn('sendClientSummary: missing identity fields');
      return { outcome: ERROR_OUTCOME };
    }

    // Defensa-en-profundidad: solo staff permitido (los clientes nunca reciben
    // este botón, pero gateamos igual). Guacuco re-valida cross-business + rol.
    if (
      !isToolAllowed(
        'send_client_summary',
        identity.profileType,
        identity.roleId,
        identity.platformId,
      )
    ) {
      deps.logger.warn('sendClientSummary: tool not permitted for role', {
        profileType: identity.profileType,
        roleId: identity.roleId,
      });
      return { outcome: FORBIDDEN_OUTCOME };
    }

    const appointmentRef = resolveAppointmentRef(state);
    if (!appointmentRef) {
      deps.logger.warn('sendClientSummary: no appointment reference resolvable from tap');
      return { outcome: NOT_FOUND_OUTCOME };
    }

    try {
      const result = await deps.guacuco.sendClientSummary(appointmentRef, identity);
      const text = result?.message?.trim();
      if (!text) {
        deps.logger.warn('sendClientSummary: empty message from Guacuco');
        return { outcome: ERROR_OUTCOME };
      }
      const outcome: Outcome = {
        action: 'response',
        pendingReply: { text },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('sendClientSummary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
