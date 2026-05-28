import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { ScheduleAppointmentResult } from '../../../../clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../core/errors/ToolExecutionError.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { toolCallErrorCode, withToolCall } from '../../common/state.js';
import { assertSlotsResolved } from '../assertions.js';
import type { AppointmentDraftState } from '../state.js';

const TOOL_NAME = 'schedule_appointment';

/**
 * Nodo `commit`: ejecuta el side effect en Guacuco (`scheduleAppointment`)
 * con `idempotency_key = confirmation.intentUuid` (spec P1).
 *
 * Anti-alucinación:
 * - `assertSlotsResolved(...)` antes de cualquier llamada. Si falla, lanza
 *   `IdpError('invariant_violated')` — el wrapper del subgrafo lo captura y
 *   produce `terminalOutcome=error`.
 * - Valores leídos del state (`slots.*.value`, `identity.*`, `intentUuid`).
 *   El LLM no participa en este paso.
 *
 * Error handling INLINE (deviación documentada del plan §2.2 que separaba
 * `error_handler`):
 * - `STAFF_NOT_AVAILABLE` (race condition): recoverable la primera vez.
 *   Invalida `availability` cache + retorna `phase='validating_availability'`
 *   para re-fetch. Si ya estamos en el 2do intento (recoverableErrors ya
 *   contiene este código) → handed_off.
 * - `IDEMPOTENT_REQUEST_IN_PROGRESS` (P1): retorna handed_off limpio — la
 *   creación está en vuelo o ya pasó, otro request va a manejarla.
 * - `BUSINESS_MISMATCH`: no-recoverable. terminalOutcome=error.
 * - Cualquier otro `ToolExecutionError`: handed_off (humano interviene).
 * - Errores de red / Error genérico: terminalOutcome=error.
 *
 * Identity dual (staff agendando para tercero): requiere `slots.clientUuid.value`
 * (UUID literal). En v1 ese slot llega con `userPhrase` (texto libre) sin
 * `value` → handed_off documentado.
 */

export interface CommitDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const RECOVERABLE_CODES: ReadonlySet<string> = new Set(['STAFF_NOT_AVAILABLE']);
const NO_RETRY_CODES: ReadonlySet<string> = new Set(['BUSINESS_MISMATCH']);

const HANDED_OFF_GENERIC: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No pude completar el agendamiento. Un humano del equipo te va a contactar a la brevedad.',
  },
};

const ERROR_GENERIC: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'Tuve un problema técnico al agendar. Probá de nuevo en un minuto.',
  },
};

const HANDED_OFF_NO_CLIENT_UUID: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No pude identificar al cliente. Un humano del equipo te va a contactar a la brevedad.',
  },
};

const HANDED_OFF_IN_PROGRESS: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'Ya hay una reserva siendo procesada para este turno. Un humano del equipo te va a contactar para confirmar.',
  },
};

export function makeCommitNode(deps: CommitDeps) {
  const { guacuco, logger } = deps;

  return async function commit(state: {
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    const identity = state.identity;
    if (!current || !identity) {
      return { phase: 'failed', terminalOutcome: ERROR_GENERIC };
    }

    // Anti-alucinación: lanza si invariante rota. El wrapper del subgrafo
    // (en H4.6) atrapa y produce el outcome correspondiente.
    assertSlotsResolved(current.slots, identity.profileType);

    const clientUuid = resolveClientUuid(current, identity);
    if (!clientUuid) {
      logger.warn('commit: cannot resolve client_uuid for staff role (text-only entry)', {
        clientPhrase: current.slots.clientUuid?.userPhrase,
      });
      return {
        phase: 'failed',
        meta: { attempts: 0, recoverableErrors: ['MISSING_CLIENT_UUID'] },
        terminalOutcome: HANDED_OFF_NO_CLIENT_UUID,
      };
    }

    const intentUuid = current.confirmation.intentUuid;
    if (!intentUuid) {
      logger.warn('commit: missing intentUuid (idempotency key)');
      return { phase: 'failed', terminalOutcome: ERROR_GENERIC };
    }

    const params = buildScheduleParams(current, identity, clientUuid);

    let result: ScheduleAppointmentResult;
    try {
      result = await guacuco.scheduleAppointment(params, { idempotencyKey: intentUuid });
    } catch (err) {
      const code = toolCallErrorCode(err);
      return withToolCall(handleCommitError(err, current, logger), {
        toolName: TOOL_NAME,
        input: params,
        resultStatus: 'error',
        ...(code ? { errorCode: code } : {}),
      });
    }

    logger.debug('commit success', {
      appointmentUuid: result.appointment_uuid,
      status: result.status,
    });

    // El terminalOutcome real (success message) lo arma successResponse. Acá
    // sólo marcamos phase='done' + registramos el tool_call ejecutado.
    return withToolCall<Partial<AppointmentDraftState>>(
      { phase: 'done' },
      { toolName: TOOL_NAME, input: params, resultStatus: 'ok' },
    );
  };
}

function resolveClientUuid(state: AppointmentDraftState, identity: Identity): string | null {
  if (identity.profileType === 'client') return identity.profileUuid;

  const slot = state.slots.clientUuid;
  if (slot?.status === 'resolved' && typeof slot.value === 'string' && slot.value.length > 0) {
    return slot.value;
  }
  return null;
}

function buildScheduleParams(state: AppointmentDraftState, identity: Identity, clientUuid: string) {
  const { services, staff, date, time } = state.slots;
  return {
    business_allia_id: identity.tenantAlliaId,
    date: date.value as string,
    appointment_time: time.value as string,
    client_uuid: clientUuid,
    staff_uuid: staff.value as string,
    service_uuids: services.value as string[],
  };
}

function handleCommitError(
  err: unknown,
  current: AppointmentDraftState,
  logger: Logger,
): Partial<AppointmentDraftState> {
  if (err instanceof ToolExecutionError) {
    const code = err.code;
    logger.warn('commit: Guacuco returned error', { code, message: err.message });

    if (RECOVERABLE_CODES.has(code)) {
      const alreadyRetried = current.meta.recoverableErrors.includes(code);
      if (alreadyRetried) {
        return {
          phase: 'failed',
          meta: { attempts: 0, recoverableErrors: [code] },
          terminalOutcome: HANDED_OFF_GENERIC,
        };
      }
      // Primer race: invalida cache, limpia confirmation, vuelve a validate.
      return {
        availability: { proposedSlots: [] },
        confirmation: {},
        phase: 'validating_availability',
        meta: { attempts: 0, recoverableErrors: [code] },
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

    // Default para códigos no mapeados: handed_off (humano interviene).
    return {
      phase: 'failed',
      meta: { attempts: 0, recoverableErrors: [code] },
      terminalOutcome: HANDED_OFF_GENERIC,
    };
  }

  // Errores de red / no-ToolExecutionError → error genérico.
  logger.warn('commit: unexpected error', {
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    phase: 'failed',
    meta: { attempts: 0, recoverableErrors: ['UNEXPECTED'] },
    terminalOutcome: ERROR_GENERIC,
  };
}
