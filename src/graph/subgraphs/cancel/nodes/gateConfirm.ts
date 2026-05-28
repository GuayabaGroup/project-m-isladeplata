import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { CancelDraftState } from '../state.js';

/**
 * Gate de confirmación para cancel. Mismo patrón que schedule.gateConfirm
 * pero opera sobre `CancelDraftState`. Texto y semántica distintos:
 *
 * - `confirm:<uuid>` matchea → `phase='committing'` (procede al cancel commit).
 * - `cancel:<uuid>` matchea → cancel del gate (NO del turno) — limpia
 *   confirmation, vuelve a 'collecting'. Slots preservados para que el
 *   usuario eventualmente elija otro turno.
 * - Stale uuid o texto libre → cancel implícito (idem).
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
    if (!current) return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };

    const { intentUuid, message } = current.confirmation;
    if (!intentUuid || !message) {
      logger.warn('cancel.gateConfirm: missing intentUuid or message');
      return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }

    const payload: NonNullable<Outcome['pendingReply']> = {
      text: message,
      buttons: [
        { id: `confirm:${intentUuid}`, title: 'Sí, cancelar' },
        { id: `cancel:${intentUuid}`, title: 'No' },
      ],
    };

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('cancel.gateConfirm resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return processReply(reply, current);
  };
}

function processReply(
  reply: ResumePayload | undefined,
  current: CancelDraftState,
): Partial<CancelDraftState> {
  const safe = reply ?? { text: '' };
  const buttonId = safe.buttonId;
  const intentUuid = current.confirmation.intentUuid;

  if (buttonId && intentUuid) {
    if (buttonId === `confirm:${intentUuid}`) {
      return { phase: 'committing' };
    }
    if (buttonId === `cancel:${intentUuid}`) {
      return cancelGate();
    }
  }

  // Stale uuid, button distinto, texto libre → cancel del gate (no del turno)
  return cancelGate();
}

/**
 * Cancela el gate (no el turno). Limpia confirmation. Vuelve a 'collecting'.
 * Slots preservados para que el usuario reintente con otro turno si quiere.
 */
function cancelGate(): Partial<CancelDraftState> {
  return {
    confirmation: {},
    phase: 'collecting',
  };
}
