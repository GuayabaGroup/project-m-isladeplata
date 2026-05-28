import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type {
  ValidateRescheduleProposedSlot,
  ValidateRescheduleSlotResult,
} from '../../../../clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { RescheduleAvailabilityCache, RescheduleDraftState } from '../state.js';

/**
 * Pre-valida el slot nuevo via `validate_reschedule_slot` (tool legacy invocado
 * via executeTool). Guacuco deriva staff/services del appointment_uuid.
 *
 * Mapeo respuesta:
 * - `passed: true` → exactMatch=true (proposed_slots tiene el slot exacto que
 *   el usuario pidió; lo ignoramos porque ya está en los slots resueltos).
 * - `passed: false` → exactMatch=false. Si vienen proposed_slots → present_options;
 *   si vacíos → present_options decide handed_off.
 */

export interface RescheduleValidateDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

const NETWORK_ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude validar la disponibilidad en este momento. Probá de nuevo en un minuto.',
  },
};

export function makeRescheduleValidateNode(deps: RescheduleValidateDeps) {
  const { guacuco, logger } = deps;

  return async function validateAvailability(state: {
    identity?: Identity | null;
    subgraphState?: unknown;
  }): Promise<Partial<RescheduleDraftState>> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) {
      logger.warn('reschedule.validate: no subgraphState');
      return {};
    }

    const identity = state.identity;
    if (!identity?.profileUuid) {
      logger.warn('reschedule.validate: missing identity.profileUuid');
      return { phase: 'failed', terminalOutcome: NETWORK_ERROR_OUTCOME };
    }

    const { appointmentUuid, newDate, newTime } = current.slots;
    if (
      appointmentUuid.status !== 'resolved' ||
      !appointmentUuid.value ||
      newDate.status !== 'resolved' ||
      !newDate.value ||
      newTime.status !== 'resolved' ||
      !newTime.value
    ) {
      logger.warn('reschedule.validate: unresolved slots');
      return { phase: 'collecting' };
    }

    const snapshot = {
      appointmentUuid: appointmentUuid.value,
      newDate: newDate.value,
      newTime: newTime.value,
    };

    let result: ValidateRescheduleSlotResult;
    try {
      result = await guacuco.validateRescheduleSlot({
        appointment_uuid: appointmentUuid.value,
        profile_uuid: identity.profileUuid,
        date_hint: [newDate.value],
        time_hint: newTime.value,
      });
    } catch (err) {
      logger.warn('reschedule.validate: Guacuco call failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { phase: 'failed', terminalOutcome: NETWORK_ERROR_OUTCOME };
    }

    const availability = buildAvailability(snapshot, result);
    logger.debug('reschedule.validate done', {
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
  snapshot: NonNullable<RescheduleAvailabilityCache['lastCheckedFor']>,
  result: ValidateRescheduleSlotResult,
): RescheduleAvailabilityCache {
  if (result.passed === true) {
    return {
      lastCheckedFor: snapshot,
      exactMatch: true,
      proposedSlots: [],
    };
  }

  const proposed = normalizeProposedSlots(result.proposed_slots);
  return {
    lastCheckedFor: snapshot,
    exactMatch: false,
    proposedSlots: proposed,
  };
}

function normalizeProposedSlots(
  raw: ValidateRescheduleProposedSlot[] | undefined,
): RescheduleAvailabilityCache['proposedSlots'] {
  if (!Array.isArray(raw)) return [];
  const out: RescheduleAvailabilityCache['proposedSlots'] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s.date !== 'string' || typeof s.time !== 'string') continue;
    const key = `${s.date}T${s.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: s.date, time: s.time, label: formatLabel(s.date, s.time) });
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
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return `${date} ${time}`;
  const monthName = SPANISH_MONTHS[m - 1] ?? '';
  return `${d} ${monthName} - ${time}`;
}
