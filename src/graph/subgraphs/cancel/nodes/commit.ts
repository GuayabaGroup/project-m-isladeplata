import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { CancelAppointmentResult } from '../../../../clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../core/errors/ToolExecutionError.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { assertSlotsResolvedGeneric, toolCallErrorCode, withToolCall } from '../../common/state.js';
import type { CancelDraftState } from '../state.js';

const TOOL_NAME = 'cancel_appointment';

/**
 * Commit del subgrafo cancel. Llama `guacuco.cancelAppointment` con
 * `idempotencyKey = confirmation.intentUuid` (spec P1).
 *
 * Anti-alucinación: `assertSlotsResolvedGeneric` antes de la llamada.
 *
 * Error handling INLINE:
 * - `APPOINTMENT_NOT_FOUND`: error terminal con texto explicativo.
 * - `APPOINTMENT_ALREADY_CANCELLED`: success silenciosa (idempotencia).
 * - `BUSINESS_MISMATCH`: error terminal.
 * - Otros ToolExecutionError: handed_off.
 * - Net errors: error.
 */

export interface CancelCommitDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const ERROR_GENERIC: Outcome = {
  action: 'error',
  pendingReply: { text: 'Tuve un problema técnico al cancelar. Probá de nuevo en un minuto.' },
};

const NOT_FOUND_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: { text: 'No encontré ese turno. Quizá ya fue cancelado.' },
};

const HANDED_OFF_GENERIC: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No pude cancelar el turno. Un humano del equipo te va a contactar.',
  },
};

export function makeCancelCommitNode(deps: CancelCommitDeps) {
  const { guacuco, logger } = deps;

  return async function commit(state: {
    subgraphState?: unknown;
  }): Promise<Partial<CancelDraftState>> {
    const current = state.subgraphState as CancelDraftState | undefined;
    if (!current) return { phase: 'failed', terminalOutcome: ERROR_GENERIC };

    assertSlotsResolvedGeneric(current.slots, ['appointmentUuid']);

    const intentUuid = current.confirmation.intentUuid;
    if (!intentUuid) {
      logger.warn('cancel.commit: missing intentUuid');
      return { phase: 'failed', terminalOutcome: ERROR_GENERIC };
    }

    const apptUuid = current.slots.appointmentUuid.value as string;
    const input = { appointment_uuid: apptUuid };

    let result: CancelAppointmentResult;
    try {
      result = await guacuco.cancelAppointment(input, { idempotencyKey: intentUuid });
    } catch (err) {
      const code = toolCallErrorCode(err);
      return withToolCall(handleError(err, logger), {
        toolName: TOOL_NAME,
        input,
        resultStatus: 'error',
        ...(code ? { errorCode: code } : {}),
      });
    }

    logger.debug('cancel.commit success', {
      appointmentUuid: result.appointment_uuid,
      status: result.status,
    });
    return withToolCall<Partial<CancelDraftState>>(
      { phase: 'done' },
      { toolName: TOOL_NAME, input, resultStatus: 'ok' },
    );
  };
}

function handleError(err: unknown, logger: Logger): Partial<CancelDraftState> {
  if (err instanceof ToolExecutionError) {
    const code = err.code;
    logger.warn('cancel.commit: Guacuco returned error', { code, message: err.message });

    if (code === 'APPOINTMENT_ALREADY_CANCELLED') {
      return { phase: 'done', meta: { attempts: 0, recoverableErrors: [code] } };
    }
    if (code === 'APPOINTMENT_NOT_FOUND') {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: NOT_FOUND_OUTCOME,
      };
    }
    if (code === 'BUSINESS_MISMATCH') {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: ERROR_GENERIC,
      };
    }
    return {
      phase: 'failed',
      meta: { attempts: 0, recoverableErrors: [code] },
      terminalOutcome: HANDED_OFF_GENERIC,
    };
  }

  logger.warn('cancel.commit: unexpected error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    phase: 'failed',
    meta: { attempts: 0, recoverableErrors: ['UNEXPECTED'] },
    terminalOutcome: ERROR_GENERIC,
  };
}
