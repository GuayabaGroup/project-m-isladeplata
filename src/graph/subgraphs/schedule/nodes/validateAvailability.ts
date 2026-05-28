import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { ToolValidateResult } from '../../../../clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { AppointmentDraftState, AvailabilityCache } from '../state.js';

/**
 * Llama `guacuco.validateScheduleSlot(...)` y popula `availability` en el
 * subgraph state.
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

    let result: ToolValidateResult;
    try {
      result = await guacuco.validateScheduleSlot({
        date: date.value,
        appointment_time: time.value,
        business_allia_id: identity.tenantAlliaId,
        staff_uuid: staff.value,
        service_uuids: services.value,
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
  result: ToolValidateResult,
): AvailabilityCache {
  if (result.valid === true) {
    return {
      lastCheckedFor: snapshot,
      exactMatch: true,
      proposedSlots: [],
    };
  }

  const proposed = normalizeSuggestions(result, snapshot);
  return {
    lastCheckedFor: snapshot,
    exactMatch: false,
    proposedSlots: proposed,
  };
}

/**
 * Convierte `suggestions` del shape Guacuco a `proposedSlots` con label
 * legible. Preferencia: `combined` (formato "YYYY-MM-DD HH:mm"). Fallback a
 * `date[]` o `appointment_time[]` aislados.
 */
function normalizeSuggestions(
  result: ToolValidateResult,
  snapshot: NonNullable<AvailabilityCache['lastCheckedFor']>,
): AvailabilityCache['proposedSlots'] {
  const out: AvailabilityCache['proposedSlots'] = [];
  const seen = new Set<string>();

  const pushIfFresh = (date: string, time: string) => {
    const key = `${date}T${time}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ date, time, label: formatLabel(date, time) });
  };

  const combined = result.suggestions?.combined;
  if (Array.isArray(combined)) {
    for (const entry of combined) {
      const parsed = parseCombined(entry);
      if (parsed) pushIfFresh(parsed.date, parsed.time);
    }
  }

  const dateOnly = result.suggestions?.date;
  if (Array.isArray(dateOnly)) {
    for (const d of dateOnly) {
      if (typeof d === 'string') pushIfFresh(d, snapshot.time);
    }
  }

  const timeOnly = result.suggestions?.appointment_time;
  if (Array.isArray(timeOnly)) {
    for (const t of timeOnly) {
      if (typeof t === 'string') pushIfFresh(snapshot.date, t);
    }
  }

  return out;
}

function parseCombined(entry: string): { date: string; time: string } | null {
  if (typeof entry !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2})$/.exec(entry.trim());
  if (!m || !m[1] || !m[2]) return null;
  return { date: m[1], time: m[2] };
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
