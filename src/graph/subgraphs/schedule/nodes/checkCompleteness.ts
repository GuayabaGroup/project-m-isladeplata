import type { ProfileType } from '../../../../core/enums/ProfileType.js';
import type { AppointmentDraftSlots } from '../state.js';
import { requiredSlots } from '../state.js';

/**
 * Decide qué slot pedir a continuación. Función pura — no muta state.
 *
 * Granularidad acordada (decisión §10.4 REGLAS + §11 PLAN_H4):
 * - Services y staff se piden en mensajes separados (list de WhatsApp).
 * - `date` + `time` se piden JUNTOS (texto libre) para reducir turnos.
 * - `clientUuid` (rol=staff) se pide aparte con texto libre.
 *
 * Retorna `null` cuando todos los slots requeridos están resueltos →
 * el grafo rutea a `validate_availability`.
 */
export type MissingSlot = 'services' | 'staff' | 'date_time' | 'clientUuid';

export function checkCompleteness(
  slots: AppointmentDraftSlots,
  profileType: ProfileType,
): MissingSlot | null {
  const required = requiredSlots(profileType);

  if (required.includes('services') && slots.services.status !== 'resolved') return 'services';
  if (required.includes('staff') && slots.staff.status !== 'resolved') return 'staff';

  const dateResolved = slots.date.status === 'resolved';
  const timeResolved = slots.time.status === 'resolved';
  if (required.includes('date') || required.includes('time')) {
    if (!dateResolved || !timeResolved) return 'date_time';
  }

  if (
    required.includes('clientUuid') &&
    (!slots.clientUuid || slots.clientUuid.status !== 'resolved')
  ) {
    return 'clientUuid';
  }

  return null;
}
