import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { ConfirmAppointmentResult } from '../../../../clients/types/GuacucoTypes.js';
import { GUACUCO_TOOLS } from '../../../../core/enums/GuacucoToolName.js';
import { ToolExecutionError } from '../../../../core/errors/ToolExecutionError.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { assertSlotsResolvedGeneric, toolCallErrorCode, withToolCall } from '../../common/state.js';
import type { ConfirmDraftState } from '../state.js';

const TOOL_NAME = GUACUCO_TOOLS.CONFIRM_APPOINTMENT;

/**
 * Commit del subgrafo confirm: llama `guacuco.confirmAppointment`. SIN gate
 * previo (decisión §0 tabla PLAN_H5 — la tool es confirmatoria por sí misma).
 *
 * Anti-alucinación: `assertSlotsResolvedGeneric` antes de la llamada.
 *
 * Idempotency: pasamos `idempotencyKey = randomUUID()` por consistencia con
 * schedule. Para confirm la tool es idempotente naturalmente (confirmar 2x es
 * no-op en Guacuco), pero el key ayuda a deduplicar reintentos de red.
 *
 * Error handling INLINE (mismo patrón que schedule.commit):
 * - `APPOINTMENT_ALREADY_CONFIRMED`: success silenciosa (idempotencia).
 * - `APPOINTMENT_NOT_FOUND`: error terminal.
 * - `BUSINESS_MISMATCH`: error terminal.
 * - Otros ToolExecutionError: handed_off.
 * - Net errors: error.
 */

export interface ConfirmCommitDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const ERROR_GENERIC: Outcome = {
  action: 'error',
  pendingReply: { text: 'Tuve un problema técnico al confirmar. Probá de nuevo en un minuto.' },
};

const NOT_FOUND_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: { text: 'No encontré ese turno. Quizá ya fue cancelado.' },
};

const HANDED_OFF_GENERIC: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No pude confirmar el turno. Un humano del equipo te va a contactar.',
  },
};

export function makeConfirmCommitNode(deps: ConfirmCommitDeps) {
  const { guacuco, logger } = deps;

  return async function commit(state: {
    identity?: Identity | null;
    subgraphState?: unknown;
  }): Promise<Partial<ConfirmDraftState>> {
    const current = state.subgraphState as ConfirmDraftState | undefined;
    if (!current) return { phase: 'failed', terminalOutcome: ERROR_GENERIC };

    const identity = state.identity;
    if (!identity) {
      logger.warn('confirm.commit: missing identity');
      return { phase: 'failed', terminalOutcome: ERROR_GENERIC };
    }

    // assertSlotsResolvedGeneric lanza IdpError('invariant_violated') si fail.
    assertSlotsResolvedGeneric(current.slots, ['appointmentUuid']);

    const apptUuid = current.slots.appointmentUuid.value as string;
    const idempotencyKey = randomUUID();

    const input = { appointment_uuid: apptUuid };
    let result: ConfirmAppointmentResult;
    try {
      result = await guacuco.confirmAppointment(input, identity, { idempotencyKey });
    } catch (err) {
      const code = toolCallErrorCode(err);
      return withToolCall(handleError(err, logger), {
        toolName: TOOL_NAME,
        input,
        resultStatus: 'error',
        ...(code ? { errorCode: code } : {}),
      });
    }

    logger.debug('confirm.commit success', {
      appointmentUuid: result.appointment_uuid,
      status: result.status,
    });
    return withToolCall<Partial<ConfirmDraftState>>(
      { phase: 'done' },
      { toolName: TOOL_NAME, input, resultStatus: 'ok' },
    );
  };
}

function handleError(err: unknown, logger: Logger): Partial<ConfirmDraftState> {
  if (err instanceof ToolExecutionError) {
    const code = err.code;
    logger.warn('confirm.commit: Guacuco returned error', { code, message: err.message });

    if (code === 'APPOINTMENT_ALREADY_CONFIRMED') {
      // Idempotencia natural: silent success.
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

  logger.warn('confirm.commit: unexpected error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    phase: 'failed',
    meta: { attempts: 0, recoverableErrors: ['UNEXPECTED'] },
    terminalOutcome: ERROR_GENERIC,
  };
}
