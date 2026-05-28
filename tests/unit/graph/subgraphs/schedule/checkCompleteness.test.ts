import { describe, expect, it } from 'vitest';
import { checkCompleteness } from '../../../../../src/graph/subgraphs/schedule/nodes/checkCompleteness.js';
import { initialAppointmentDraftState } from '../../../../../src/graph/subgraphs/schedule/state.js';

function resolved<T>(value: T): { value: T; status: 'resolved' } {
  return { value, status: 'resolved' };
}

describe('checkCompleteness', () => {
  it('returns "services" when all slots empty', () => {
    const draft = initialAppointmentDraftState('client');
    expect(checkCompleteness(draft.slots, 'client')).toBe('services');
  });

  it('returns "staff" when services resolved but staff empty', () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = resolved(['svc-1']);
    expect(checkCompleteness(draft.slots, 'client')).toBe('staff');
  });

  it('returns "date_time" when services + staff resolved but date+time empty', () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = resolved(['svc-1']);
    draft.slots.staff = resolved('stf-1');
    expect(checkCompleteness(draft.slots, 'client')).toBe('date_time');
  });

  it('returns "date_time" when only date resolved but time missing', () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = resolved(['svc-1']);
    draft.slots.staff = resolved('stf-1');
    draft.slots.date = resolved('2026-05-28');
    expect(checkCompleteness(draft.slots, 'client')).toBe('date_time');
  });

  it('returns null when all required (client) resolved', () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = resolved(['svc-1']);
    draft.slots.staff = resolved('stf-1');
    draft.slots.date = resolved('2026-05-28');
    draft.slots.time = resolved('16:00');
    expect(checkCompleteness(draft.slots, 'client')).toBeNull();
  });

  it('returns "clientUuid" when staff role and clientUuid missing (everything else resolved)', () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = resolved(['svc-1']);
    draft.slots.staff = resolved('stf-1');
    draft.slots.date = resolved('2026-05-28');
    draft.slots.time = resolved('16:00');
    expect(checkCompleteness(draft.slots, 'staff')).toBe('clientUuid');
  });

  it('returns null for staff when ALL slots including clientUuid resolved', () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = resolved(['svc-1']);
    draft.slots.staff = resolved('stf-1');
    draft.slots.date = resolved('2026-05-28');
    draft.slots.time = resolved('16:00');
    draft.slots.clientUuid = resolved('client-uuid');
    expect(checkCompleteness(draft.slots, 'staff')).toBeNull();
  });

  it('staff role: services missing → still returns "services" first', () => {
    const draft = initialAppointmentDraftState('staff');
    expect(checkCompleteness(draft.slots, 'staff')).toBe('services');
  });

  it('guessed status is treated as NOT resolved', () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { userPhrase: 'corte', status: 'guessed' };
    expect(checkCompleteness(draft.slots, 'client')).toBe('services');
  });
});
