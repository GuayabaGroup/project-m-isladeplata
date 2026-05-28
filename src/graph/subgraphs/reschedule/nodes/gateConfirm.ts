import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Gate de confirmación del reschedule. Mismo patrón que cancel/schedule.
 *
 * - `confirm:<uuid>` matchea → `phase='committing'`.
 * - `cancel:<uuid>` matchea → cancel del gate (limpia confirmation, vuelve a
 *   collecting). Slots preservados.
 * - Stale uuid o texto libre → cancel implícito.
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
    if (!current) return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };

    const { intentUuid, message } = current.confirmation;
    if (!intentUuid || !message) {
      logger.warn('reschedule.gateConfirm: missing intentUuid or message');
      return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }

    const payload: NonNullable<Outcome['pendingReply']> = {
      text: message,
      buttons: [
        { id: `confirm:${intentUuid}`, title: 'Sí, reagendar' },
        { id: `cancel:${intentUuid}`, title: 'No' },
      ],
    };

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('reschedule.gateConfirm resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return processReply(reply, current);
  };
}

function processReply(
  reply: ResumePayload | undefined,
  current: RescheduleDraftState,
): Partial<RescheduleDraftState> {
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

  return cancelGate();
}

function cancelGate(): Partial<RescheduleDraftState> {
  return {
    confirmation: {},
    phase: 'collecting',
  };
}
