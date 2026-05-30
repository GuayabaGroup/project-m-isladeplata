import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { ConfirmDraftState } from '../state.js';

/**
 * Bootstrap del subgrafo `confirm`. Lee `crmContext.upcomingAppointments`:
 *
 * - **0 upcomings** → `terminalOutcome = response("no tenés turnos próximos para confirmar")`,
 *   `phase = 'failed'`. El finalize lo propaga.
 * - **1 upcoming** → pre-fill `slots.appointmentUuid` resolved, `phase = 'committing'`.
 *   Auto-commit (decisión §7.2 PLAN_H5 — Recommended option).
 * - **2+ upcomings** → `phase = 'collecting'`. El `ask_slot` lo lista.
 */

export interface ConfirmBootstrapDeps {
  logger: Logger;
}

const NO_UPCOMINGS_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No tenés turnos próximos para confirmar. Si querés agendar uno nuevo, decímelo.',
  },
};

export function makeConfirmBootstrapNode(deps: ConfirmBootstrapDeps) {
  const { logger } = deps;

  return function bootstrap(state: {
    crmContext?: CrmContext;
    subgraphState?: unknown;
  }): Partial<ConfirmDraftState> {
    const current = state.subgraphState as ConfirmDraftState | undefined;
    const upcomings = state.crmContext?.upcomingAppointments ?? [];

    // Pre-selección por tap en botón de recordatorio: el dispatch ya resolvió
    // `appointmentUuid`. Validamos contra upcomings y auto-commiteamos (confirmar
    // es idempotente). Si el uuid quedó stale, caemos a la lógica por count.
    const pre = current?.slots?.appointmentUuid;
    if (pre?.status === 'resolved' && pre.value) {
      const match = upcomings.find((u) => u.appointmentUuid === pre.value);
      if (match) {
        logger.debug('confirm.bootstrap: pre-selected via button (auto-commit)', {
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
          phase: 'committing',
        };
      }
      logger.debug('confirm.bootstrap: pre-selected uuid stale, fallback to count', {
        uuid: pre.value,
      });
    }

    if (upcomings.length === 0) {
      logger.debug('confirm.bootstrap: no upcomings');
      return { phase: 'failed', terminalOutcome: NO_UPCOMINGS_OUTCOME };
    }

    if (upcomings.length === 1) {
      const only = upcomings[0] as UpcomingAppointment;
      logger.debug('confirm.bootstrap: single upcoming, auto-fill', {
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
        phase: 'committing',
      };
    }

    // 2+ upcomings: queda en collecting; askSlot los lista.
    logger.debug('confirm.bootstrap: multiple upcomings, will ask', {
      count: upcomings.length,
    });
    return { phase: 'collecting' };
  };
}
