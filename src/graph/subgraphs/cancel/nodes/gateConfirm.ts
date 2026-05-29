import type { Logger } from 'winston';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { runGateConfirm } from '../../common/gateConfirm.js';
import type { CancelDraftState } from '../state.js';

/**
 * Gate de confirmación para cancel. La mecánica (interrupt + matching de
 * `intentUuid`) vive en `common/gateConfirm.ts`; acá solo el texto/título
 * propios y el mapeo de la decisión a `Partial<CancelDraftState>`:
 *
 * - `confirm:<uuid>` → `phase='committing'` (procede al cancel commit).
 * - `cancel:<uuid>`, stale uuid o texto libre → cancel del GATE (no del turno):
 *   limpia confirmation, vuelve a 'collecting'. Slots preservados para que el
 *   usuario eventualmente elija otro turno.
 * - confirmación ausente → `phase='failed'` con outcome de error.
 */

export interface CancelGateDeps {
  logger: Logger;
}

const NO_GATE_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'Tuve un problema preparando la cancelación. Probá de nuevo en un minuto.',
  },
};

export function makeCancelGateConfirmNode(deps: CancelGateDeps) {
  const { logger } = deps;

  return function gateConfirm(state: {
    subgraphState?: unknown;
  }): Partial<CancelDraftState> {
    const current = state.subgraphState as CancelDraftState | undefined;
    switch (runGateConfirm({ logger, confirmTitle: 'Sí, cancelar', logLabel: 'cancel' }, current)) {
      case 'commit':
        return { phase: 'committing' };
      case 'reset_gate':
        return { confirmation: {}, phase: 'collecting' };
      default:
        return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }
  };
}
