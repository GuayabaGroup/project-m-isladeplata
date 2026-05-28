/**
 * State del subgrafo `schedule_appointment`. Independiente del state global;
 * vive embebido en `state.subgraphState` mientras el subgrafo está activo
 * (el reducer del state global lo trata como `unknown` con `replaceWith`).
 *
 * El propio subgrafo es un `StateGraph<AppointmentDraftState>` con sus
 * propios reducers (definidos en compile.ts del subgrafo).
 */

import type { ProfileType } from '../../../core/enums/ProfileType.js';
import type { Outcome } from '../../../core/types/Outcome.js';
import type { SlotState, SlotStatus, SubgraphMeta } from '../common/state.js';

export type { SlotState, SlotStatus };

export type SchedulePhase =
  | 'collecting'
  | 'resolving_entities'
  | 'validating_availability'
  | 'awaiting_pick'
  | 'awaiting_confirmation'
  | 'committing'
  | 'done'
  | 'failed';

export interface AppointmentDraftSlots {
  /** UUIDs de servicios — plural porque Guacuco soporta multi-servicio. */
  services: SlotState<string[]>;
  staff: SlotState<string>;
  date: SlotState<string>; // YYYY-MM-DD
  time: SlotState<string>; // HH:mm
  /** Solo presente si `identity.profileType === 'staff'` agenda para tercero. */
  clientUuid?: SlotState<string>;
}

export interface AvailabilityCache {
  /** Snapshot de los slot values en el momento del check. */
  lastCheckedFor?: {
    date: string;
    time: string;
    staffUuid: string;
    serviceUuids: string[];
  };
  /** True si Guacuco confirmó que el slot exacto está disponible. */
  exactMatch?: boolean;
  /** Sugerencias devueltas por Guacuco (combined o slot-specific). */
  proposedSlots: Array<{ date: string; time: string; label: string }>;
}

export interface ConfirmationGate {
  /** UUID del intento (previene taps stale, §21.6 IDP v2). */
  intentUuid?: string;
  /** Texto formulado por el LLM (cacheado para sobrevivir re-runs). */
  message?: string;
  requestedAt?: string;
}

export type ScheduleMeta = SubgraphMeta;

export interface AppointmentDraftState {
  /** Discriminador para que el reducer del parent rutee al merge correcto. */
  __kind: 'schedule';
  slots: AppointmentDraftSlots;
  availability: AvailabilityCache;
  confirmation: ConfirmationGate;
  phase: SchedulePhase;
  meta: ScheduleMeta;
  /** Set por nodos terminales (commit, error_handler, askSlot anti-loop). El
   * wrapper del subgrafo en el parent graph lo propaga al `state.outcome`
   * global y limpia `subgraphState` al cerrar. */
  terminalOutcome?: Outcome;
}

const EMPTY_SLOT: SlotState<never> = { status: 'empty' };

/**
 * Estado inicial al entrar al subgrafo. `entry` lo populará con
 * `userPhrase` si extrae entidades del mensaje actual.
 */
export function initialAppointmentDraftState(profileType: ProfileType): AppointmentDraftState {
  const slots: AppointmentDraftSlots = {
    services: { ...(EMPTY_SLOT as SlotState<string[]>) },
    staff: { ...(EMPTY_SLOT as SlotState<string>) },
    date: { ...(EMPTY_SLOT as SlotState<string>) },
    time: { ...(EMPTY_SLOT as SlotState<string>) },
  };
  if (profileType === 'staff') {
    slots.clientUuid = { ...(EMPTY_SLOT as SlotState<string>) };
  }
  return {
    __kind: 'schedule',
    slots,
    availability: { proposedSlots: [] },
    confirmation: {},
    phase: 'resolving_entities',
    meta: { attempts: 0, recoverableErrors: [] },
  };
}

/**
 * Reducer para sumar `meta.attempts` cuando los nodos retornan
 * `{meta: {attempts: 1}}` sin conocer el valor actual.
 */
export function sumAttempts(current: number, next: number): number {
  return current + next;
}

/** Reducer para append a `meta.recoverableErrors`. */
export function appendErrors(current: string[], next: string[]): string[] {
  return [...current, ...next];
}

/**
 * Lista de slots requeridos según rol. `staff` requiere `clientUuid` extra
 * (decisión §11 PLAN_H4 — scope IN v1, ask_slot texto libre).
 */
export function requiredSlots(profileType: ProfileType): Array<keyof AppointmentDraftSlots> {
  const base: Array<keyof AppointmentDraftSlots> = ['services', 'staff', 'date', 'time'];
  if (profileType === 'staff') base.push('clientUuid');
  return base;
}
