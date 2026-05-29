import type { Logger } from 'winston';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { runGateConfirm } from '../../common/gateConfirm.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Gate de confirmación del reschedule. La mecánica (interrupt + matching de
 * `intentUuid`) vive en `common/gateConfirm.ts`; acá solo el texto/título
 * propios y el mapeo de la decisión a `Partial<RescheduleDraftState>`:
 *
 * - `confirm:<uuid>` → `phase='committing'`.
 * - `cancel:<uuid>`, stale uuid o texto libre → cancel del GATE (limpia
 *   confirmation, vuelve a 'collecting'). Slots preservados.
 * - confirmación ausente → `phase='failed'` con outcome de error.
 */

export interface RescheduleGateDeps {
  logger: Logger;
}

const NO_GATE_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'Tuve un problema preparando el reagendamiento. Probá de nuevo en un minuto.',
  },
};

export function makeRescheduleGateConfirmNode(deps: RescheduleGateDeps) {
  const { logger } = deps;

  return function gateConfirm(state: {
    subgraphState?: unknown;
  }): Partial<RescheduleDraftState> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    switch (
      runGateConfirm({ logger, confirmTitle: 'Sí, reagendar', logLabel: 'reschedule' }, current)
    ) {
      case 'commit':
        return { phase: 'committing' };
      case 'reset_gate':
        return { confirmation: {}, phase: 'collecting' };
      default:
        return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }
  };
}
