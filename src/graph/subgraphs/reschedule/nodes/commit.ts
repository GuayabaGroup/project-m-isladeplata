import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { RescheduleAppointmentResult } from '../../../../clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../core/errors/ToolExecutionError.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { assertSlotsResolvedGeneric } from '../../common/state.js';
import { RESCHEDULE_REQUIRED_SLOTS, type RescheduleDraftState } from '../state.js';

/**
 * Commit del subgrafo reschedule. Llama `guacuco.rescheduleAppointment` con
 * `idempotencyKey = confirmation.intentUuid` (spec P1).
 *
 * Anti-alucinación: `assertSlotsResolvedGeneric` antes de la llamada.
 *
 * Error handling INLINE (mirror del schedule.commit):
 * - `STAFF_NOT_AVAILABLE` (race): recoverable la primera vez → invalidate
 *   availability + confirmation, vuelve a `validating_availability`. 2da vez
 *   → handed_off.
 * - `APPOINTMENT_NOT_FOUND`: error terminal.
 * - `APPOINTMENT_ALREADY_CANCELLED`/`APPOINTMENT_NOT_ACTIVE`: error terminal
 *   (el usuario quiere reagendar algo que ya no se puede).
 * - `BUSINESS_MISMATCH`: error terminal.
 * - `IDEMPOTENT_REQUEST_IN_PROGRESS`: handed_off limpio.
 * - Otros ToolExecutionError: handed_off.
 * - Net errors: error.
 */

export interface RescheduleCommitDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const RECOVERABLE_CODES: ReadonlySet<string> = new Set(['STAFF_NOT_AVAILABLE']);
const NO_RETRY_CODES: ReadonlySet<string> = new Set([
  'BUSINESS_MISMATCH',
  'APPOINTMENT_ALREADY_CANCELLED',
  'APPOINTMENT_NOT_ACTIVE',
]);

const ERROR_GENERIC: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'Tuve un problema técnico al reagendar. Probá de nuevo en un minuto.',
  },
};

const NOT_FOUND_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: { text: 'No encontré ese turno. Quizá ya fue cancelado o modificado.' },
};

const NOT_ACTIVE_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: { text: 'Ese turno ya no se puede reagendar (fue cancelado o completado).' },
};

const HANDED_OFF_GENERIC: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No pude completar el reagendamiento. Un humano del equipo te va a contactar.',
  },
};

const HANDED_OFF_IN_PROGRESS: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'Ya hay un reagendamiento siendo procesado para este turno. Un humano te va a confirmar.',
  },
};

export function makeRescheduleCommitNode(deps: RescheduleCommitDeps) {
  const { guacuco, logger } = deps;

  return async function commit(state: {
    subgraphState?: unknown;
  }): Promise<Partial<RescheduleDraftState>> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) return { phase: 'failed', terminalOutcome: ERROR_GENERIC };

    assertSlotsResolvedGeneric(current.slots, RESCHEDULE_REQUIRED_SLOTS);

    const intentUuid = current.confirmation.intentUuid;
    if (!intentUuid) {
      logger.warn('reschedule.commit: missing intentUuid');
      return { phase: 'failed', terminalOutcome: ERROR_GENERIC };
    }

    const apptUuid = current.slots.appointmentUuid.value as string;
    const newDate = current.slots.newDate.value as string;
    const newTime = current.slots.newTime.value as string;

    let result: RescheduleAppointmentResult;
    try {
      result = await guacuco.rescheduleAppointment(
        { appointment_uuid: apptUuid, new_date: newDate, new_time: newTime },
        { idempotencyKey: intentUuid },
      );
    } catch (err) {
      return handleError(err, current, logger);
    }

    logger.debug('reschedule.commit success', {
      appointmentUuid: result.appointment_uuid,
      status: result.status,
    });
    return { phase: 'done' };
  };
}

function handleError(
  err: unknown,
  current: RescheduleDraftState,
  logger: Logger,
): Partial<RescheduleDraftState> {
  if (err instanceof ToolExecutionError) {
    const code = err.code;
    logger.warn('reschedule.commit: Guacuco returned error', { code, message: err.message });

    if (RECOVERABLE_CODES.has(code)) {
      const alreadyRetried = current.meta.recoverableErrors.includes(code);
      if (alreadyRetried) {
        return {
          phase: 'failed',
          meta: { attempts: 0, recoverableErrors: [code] },
          terminalOutcome: HANDED_OFF_GENERIC,
        };
      }
      return {
        availability: { proposedSlots: [] },
        confirmation: {},
        phase: 'validating_availability',
        meta: { attempts: 0, recoverableErrors: [code] },
      };
    }

    if (code === 'APPOINTMENT_NOT_FOUND') {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: NOT_FOUND_OUTCOME,
      };
    }

    if (code === 'APPOINTMENT_ALREADY_CANCELLED' || code === 'APPOINTMENT_NOT_ACTIVE') {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: NOT_ACTIVE_OUTCOME,
      };
    }

    if (NO_RETRY_CODES.has(code)) {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: ERROR_GENERIC,
      };
    }

    if (code === 'IDEMPOTENT_REQUEST_IN_PROGRESS') {
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: [code] },
        terminalOutcome: HANDED_OFF_IN_PROGRESS,
      };
    }

    return {
      phase: 'failed',
      meta: { attempts: 0, recoverableErrors: [code] },
      terminalOutcome: HANDED_OFF_GENERIC,
    };
  }

  logger.warn('reschedule.commit: unexpected error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    phase: 'failed',
    meta: { attempts: 0, recoverableErrors: ['UNEXPECTED'] },
    terminalOutcome: ERROR_GENERIC,
  };
}
