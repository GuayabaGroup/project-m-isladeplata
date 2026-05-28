import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type {
  AvailabilitySuggestion,
  CheckAvailabilityResult,
} from '../../../../clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { AppointmentDraftState, AvailabilityCache } from '../state.js';

/**
 * Pre-valida el slot pedido por el usuario via `check_availability` Mode A
 * (date + time). Único path disponible en Guacuco — no existe un `/tools/validate`
 * para schedule_appointment.
 *
 * Reglas:
 * - Si todos los slots requeridos (`services`, `staff`, `date`, `time`) están
 *   `resolved` → llama Guacuco.
 * - Si alguno no está resolved → marca `exactMatch=false`, no llama. El
 *   router rebotará a `ask_slot` (lo cubre `checkCompleteness`).
 * - Si Guacuco lanza (red caída, 5xx) → `terminalOutcome: error` y `phase='failed'`.
 *   El error_handler de H4.5 maneja códigos específicos en `commit`; acá solo
 *   manejamos failures de red.
 * - `lastCheckedFor` se guarda como snapshot para que el reducer de
 *   `availability` invalide cache cuando los slots cambien (cancel_handler / mid-confirm).
 *
 * Mapeo respuesta:
 * - `available: true` → exactMatch=true, sin proposed.
 * - `available: false` → exactMatch=false, proposed desde `suggestions.schedule_appointment[]`.
 * - `available` ausente (Mode B/C) → no debería pasar acá; defensivo: exactMatch=false.
 */

export interface ValidateAvailabilityDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const NETWORK_ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude validar la disponibilidad en este momento. Probá de nuevo en un minuto.',
  },
};

export function makeValidateAvailabilityNode(deps: ValidateAvailabilityDeps) {
  const { guacuco, logger } = deps;

  return async function validateAvailability(state: {
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    if (!current) {
      logger.warn('validateAvailability: no subgraphState');
      return {};
    }
    const identity = state.identity;
    if (!identity?.tenantAlliaId) {
      logger.warn('validateAvailability: missing tenantAlliaId');
      return { phase: 'failed', terminalOutcome: NETWORK_ERROR_OUTCOME };
    }

    const { services, staff, date, time } = current.slots;
    if (
      services.status !== 'resolved' ||
      staff.status !== 'resolved' ||
      date.status !== 'resolved' ||
      time.status !== 'resolved' ||
      !Array.isArray(services.value) ||
      !staff.value ||
      !date.value ||
      !time.value
    ) {
      logger.warn('validateAvailability called with unresolved slots');
      return { phase: 'collecting' };
    }

    const snapshot = {
      date: date.value,
      time: time.value,
      staffUuid: staff.value,
      serviceUuids: services.value,
    };

    let result: CheckAvailabilityResult;
    try {
      result = await guacuco.checkAvailability({
        business_allia_id: identity.tenantAlliaId,
        staff_uuid: staff.value,
        service_uuids: services.value,
        date: date.value,
        appointment_time: time.value,
      });
    } catch (err) {
      logger.warn('validateAvailability: Guacuco call failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { phase: 'failed', terminalOutcome: NETWORK_ERROR_OUTCOME };
    }

    const availability = buildAvailability(snapshot, result);
    logger.debug('validateAvailability done', {
      exactMatch: availability.exactMatch,
      suggestions: availability.proposedSlots.length,
    });

    return {
      availability,
      phase: availability.exactMatch ? 'awaiting_confirmation' : 'awaiting_pick',
    };
  };
}

function buildAvailability(
  snapshot: NonNullable<AvailabilityCache['lastCheckedFor']>,
  result: CheckAvailabilityResult,
): AvailabilityCache {
  if (result.available === true) {
    return {
      lastCheckedFor: snapshot,
      exactMatch: true,
      proposedSlots: [],
    };
  }

  const proposed = normalizeSuggestions(result.suggestions?.schedule_appointment);
  return {
    lastCheckedFor: snapshot,
    exactMatch: false,
    proposedSlots: proposed,
  };
}

function normalizeSuggestions(
  raw: AvailabilitySuggestion[] | undefined,
): AvailabilityCache['proposedSlots'] {
  if (!Array.isArray(raw)) return [];
  const out: AvailabilityCache['proposedSlots'] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s.date !== 'string' || typeof s.appointment_time !== 'string') continue;
    const key = `${s.date}T${s.appointment_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      typeof s.label === 'string' && s.label.length > 0
        ? s.label
        : formatLabel(s.date, s.appointment_time);
    out.push({ date: s.date, time: s.appointment_time, label });
  }
  return out;
}

const SPANISH_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function formatLabel(date: string, time: string): string {
  // Parse YYYY-MM-DD sin Date object (evita timezone shifts).
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return `${date} ${time}`;
  const monthName = SPANISH_MONTHS[m - 1] ?? '';
  return `${d} ${monthName} - ${time}`;
}
