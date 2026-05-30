import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Bootstrap del subgrafo reschedule. Idéntico al cancel en la lógica de
 * appointment_uuid (0/1/N upcomings) — no toca newDate/newTime (los pedirá
 * askSlot). El gate viene después de validate, no de bootstrap.
 *
 * - 0 upcomings → response amable + failed.
 * - 1 upcoming → pre-fill appointmentUuid, phase=collecting (sigue pidiendo
 *   newDate+newTime).
 * - 2+ upcomings → collecting (askSlot mostrará la lista para pickear cuál).
 */

export interface RescheduleBootstrapDeps {
  logger: Logger;
}

const NO_UPCOMINGS_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No tenés turnos próximos para reagendar.',
  },
};

export function makeRescheduleBootstrapNode(deps: RescheduleBootstrapDeps) {
  const { logger } = deps;

  return function bootstrap(state: {
    crmContext?: CrmContext;
    subgraphState?: unknown;
  }): Partial<RescheduleDraftState> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    const upcomings = state.crmContext?.upcomingAppointments ?? [];

    // Pre-selección por tap en botón de recordatorio: el dispatch ya resolvió
    // `appointmentUuid`. Validamos contra upcomings; quedan pendientes newDate/
    // newTime (los pedirá askSlot). Si el uuid quedó stale, caemos a la lógica por count.
    const pre = current?.slots?.appointmentUuid;
    if (pre?.status === 'resolved' && pre.value) {
      const match = upcomings.find((u) => u.appointmentUuid === pre.value);
      if (match) {
        logger.debug('reschedule.bootstrap: pre-selected via button', { uuid: pre.value });
        return {
          slots: {
            appointmentUuid: {
              value: match.appointmentUuid,
              displayName: match.description,
              userPhrase: pre.userPhrase ?? 'botón',
              status: 'resolved',
            },
            newDate: { status: 'empty' },
            newTime: { status: 'empty' },
          },
          phase: 'collecting',
        };
      }
      logger.debug('reschedule.bootstrap: pre-selected uuid stale, fallback to count', {
        uuid: pre.value,
      });
    }

    if (upcomings.length === 0) {
      logger.debug('reschedule.bootstrap: no upcomings');
      return { phase: 'failed', terminalOutcome: NO_UPCOMINGS_OUTCOME };
    }

    if (upcomings.length === 1) {
      const only = upcomings[0] as UpcomingAppointment;
      logger.debug('reschedule.bootstrap: single upcoming, pre-fill', {
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
          newDate: { status: 'empty' },
          newTime: { status: 'empty' },
        },
        phase: 'collecting',
      };
    }

    logger.debug('reschedule.bootstrap: multiple upcomings, will ask', {
      count: upcomings.length,
    });
    return { phase: 'collecting' };
  };
}
