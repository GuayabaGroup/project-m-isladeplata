/**
 * State del subgrafo `cancel_appointment`. Single-slot (`appointmentUuid`)
 * CON gate de confirmación (cancelar es destructivo — §0 PLAN_H5 tabla).
 */

import type { Outcome } from '../../../core/types/Outcome.js';
import type { SlotState, SubgraphMeta } from '../common/state.js';

export type CancelPhase = 'collecting' | 'awaiting_confirmation' | 'committing' | 'done' | 'failed';

export interface CancelDraftSlots {
  appointmentUuid: SlotState<string>;
}

export interface CancelConfirmation {
  intentUuid?: string;
  message?: string;
  requestedAt?: string;
}

export interface CancelDraftState {
  __kind: 'cancel';
  slots: CancelDraftSlots;
  confirmation: CancelConfirmation;
  phase: CancelPhase;
  meta: SubgraphMeta;
  terminalOutcome?: Outcome;
}

export function initialCancelDraftState(): CancelDraftState {
  return {
    __kind: 'cancel',
    slots: { appointmentUuid: { status: 'empty' } },
    confirmation: {},
    phase: 'collecting',
    meta: { attempts: 0, recoverableErrors: [] },
  };
}
