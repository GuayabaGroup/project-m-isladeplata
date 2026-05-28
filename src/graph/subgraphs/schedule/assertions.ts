import type { ProfileType } from '../../../core/enums/ProfileType.js';
import { IdpError } from '../../../core/errors/IdpError.js';
import { type AppointmentDraftSlots, requiredSlots } from './state.js';

/**
 * Anti-alucinación (§9 REGLAS, §4.2 PLAN_H4): aserción dura antes del side
 * effect en `commit`. Lanza `IdpError('invariant_violated')` si CUALQUIER slot
 * requerido por el rol no está `resolved` con `value` no nulo.
 *
 * Reason de lanzar (vs retornar bool): si esto falla, hay un bug en la
 * lógica del subgrafo (router permitió llegar a commit sin validación). Es
 * exception territory, no flow control.
 */
export function assertSlotsResolved(slots: AppointmentDraftSlots, profileType: ProfileType): void {
  const required = requiredSlots(profileType);
  for (const key of required) {
    const slot = slots[key];
    if (!slot) {
      throw new IdpError('invariant_violated', `Required slot missing in state: ${key}`);
    }
    if (slot.status !== 'resolved') {
      throw new IdpError('invariant_violated', `Slot ${key} not resolved before commit`, {
        slot: key,
        status: slot.status,
      });
    }
    const hasValue = slot.value !== undefined && slot.value !== null;
    if (!hasValue) {
      throw new IdpError('invariant_violated', `Slot ${key} resolved but value missing`, {
        slot: key,
      });
    }
    if (key === 'services' && (!Array.isArray(slot.value) || slot.value.length === 0)) {
      throw new IdpError('invariant_violated', 'services slot must be non-empty array', {
        slot: key,
      });
    }
  }
}
