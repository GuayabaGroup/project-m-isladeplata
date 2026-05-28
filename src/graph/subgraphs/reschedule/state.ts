/**
 * State del subgrafo `reschedule_appointment`. Slots: `appointmentUuid` (turno
 * existente) + `newDate` + `newTime`. NO pide staff/services — los hereda del
 * appointment via Guacuco (`validate_reschedule_slot` deriva internamente).
 *
 * Tiene gate de confirmación como cancel (cambiar fecha es destructivo). Y tiene
 * cache de availability como schedule (pre-valida el nuevo slot, puede presentar
 * sugerencias si no está disponible).
 */

import type { Outcome } from '../../../core/types/Outcome.js';
import type { SlotState, SubgraphMeta } from '../common/state.js';

export type ReschedulePhase =
  | 'collecting'
  | 'validating_availability'
  | 'awaiting_pick'
  | 'awaiting_confirmation'
  | 'committing'
  | 'done'
  | 'failed';

export interface RescheduleDraftSlots {
  appointmentUuid: SlotState<string>;
  newDate: SlotState<string>; // YYYY-MM-DD
  newTime: SlotState<string>; // HH:mm
}

export interface RescheduleAvailabilityCache {
  /** Snapshot de los slot values en el momento del check. */
  lastCheckedFor?: {
    appointmentUuid: string;
    newDate: string;
    newTime: string;
  };
  /** True si validate confirmó que el slot exacto está disponible. */
  exactMatch?: boolean;
  /** Sugerencias devueltas (proposed_slots cuando passed=false). */
  proposedSlots: Array<{ date: string; time: string; label: string }>;
}

export interface RescheduleConfirmation {
  intentUuid?: string;
  message?: string;
  requestedAt?: string;
}

export interface RescheduleDraftState {
  __kind: 'reschedule';
  slots: RescheduleDraftSlots;
  availability: RescheduleAvailabilityCache;
  confirmation: RescheduleConfirmation;
  phase: ReschedulePhase;
  meta: SubgraphMeta;
  terminalOutcome?: Outcome;
}

export function initialRescheduleDraftState(): RescheduleDraftState {
  return {
    __kind: 'reschedule',
    slots: {
      appointmentUuid: { status: 'empty' },
      newDate: { status: 'empty' },
      newTime: { status: 'empty' },
    },
    availability: { proposedSlots: [] },
    confirmation: {},
    phase: 'collecting',
    meta: { attempts: 0, recoverableErrors: [] },
  };
}

export const RESCHEDULE_REQUIRED_SLOTS: ReadonlyArray<keyof RescheduleDraftSlots & string> = [
  'appointmentUuid',
  'newDate',
  'newTime',
];
