import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { CancelDraftState } from '../state.js';

/**
 * Bootstrap del subgrafo cancel. Diferente a confirm en 2 puntos:
 * - 1 upcoming → pre-fill PERO `phase = 'awaiting_confirmation'` (NO commit
 *   directo: cancelar es destructivo, requiere gate).
 * - El texto del "no upcomings" es específico de cancel.
 */

export interface CancelBootstrapDeps {
  logger: Logger;
}

const NO_UPCOMINGS_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No tenés turnos próximos para cancelar.',
  },
};

export function makeCancelBootstrapNode(deps: CancelBootstrapDeps) {
  const { logger } = deps;

  return function bootstrap(state: {
    crmContext?: CrmContext;
    subgraphState?: unknown;
  }): Partial<CancelDraftState> {
    const current = state.subgraphState as CancelDraftState | undefined;
    const upcomings = state.crmContext?.upcomingAppointments ?? [];

    // Pre-selección por tap en botón de recordatorio: el dispatch ya resolvió
    // `appointmentUuid`. Validamos contra upcomings, enriquecemos displayName y
    // vamos directo al gate (cancelar es destructivo). Si el uuid quedó stale
    // (no está en upcomings), caemos a la lógica por count.
    const pre = current?.slots?.appointmentUuid;
    if (pre?.status === 'resolved' && pre.value) {
      const match = upcomings.find((u) => u.appointmentUuid === pre.value);
      if (match) {
        logger.debug('cancel.bootstrap: pre-selected via button (awaiting gate)', {
          uuid: pre.value,
        });
        return {
          slots: {
            appointmentUuid: {
              value: match.appointmentUuid,
              displayName: match.description,
              userPhrase: pre.userPhrase ?? 'botón',
              status: 'resolved',
            },
          },
          phase: 'awaiting_confirmation',
        };
      }
      logger.debug('cancel.bootstrap: pre-selected uuid stale, fallback to count', {
        uuid: pre.value,
      });
    }

    if (upcomings.length === 0) {
      logger.debug('cancel.bootstrap: no upcomings');
      return { phase: 'failed', terminalOutcome: NO_UPCOMINGS_OUTCOME };
    }

    if (upcomings.length === 1) {
      const only = upcomings[0] as UpcomingAppointment;
      logger.debug('cancel.bootstrap: single upcoming, pre-fill (awaiting gate)', {
        uuid: only.appointmentUuid,
      });
      return {
        slots: {
          appointmentUuid: {
            value: only.appointmentUuid,
            displayName: only.description,
            userPhrase: 'único próximo',
            status: 'resolved',
          },
        },
        // NO va a 'committing' — necesita gate (cancel es destructivo).
        phase: 'awaiting_confirmation',
      };
    }

    logger.debug('cancel.bootstrap: multiple upcomings, will ask', { count: upcomings.length });
    return { phase: 'collecting' };
  };
}
