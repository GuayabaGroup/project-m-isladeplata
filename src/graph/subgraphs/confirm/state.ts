/**
 * State del subgrafo `confirm_appointment`. Single-slot (`appointmentUuid`).
 * NO tiene `confirmation` gate — la tool ES confirmatoria por sí misma
 * (decisión §7.2 PLAN_H5: auto-commit si 1 upcoming, ask si 2+).
 */

import type { Outcome } from '../../../core/types/Outcome.js';
import type { SlotState, SubgraphMeta } from '../common/state.js';

export type ConfirmPhase = 'collecting' | 'committing' | 'done' | 'failed';

export interface ConfirmDraftSlots {
  appointmentUuid: SlotState<string>;
}

export interface ConfirmDraftState {
  __kind: 'confirm';
  slots: ConfirmDraftSlots;
  phase: ConfirmPhase;
  meta: SubgraphMeta;
  terminalOutcome?: Outcome;
}

export function initialConfirmDraftState(): ConfirmDraftState {
  return {
    __kind: 'confirm',
    slots: { appointmentUuid: { status: 'empty' } },
    phase: 'collecting',
    meta: { attempts: 0, recoverableErrors: [] },
  };
}
