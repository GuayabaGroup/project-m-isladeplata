import { describe, expect, it } from 'vitest';
import { IdpError } from '../../../../../src/core/errors/IdpError.js';
import { assertSlotsResolved } from '../../../../../src/graph/subgraphs/schedule/assertions.js';
import { initialAppointmentDraftState } from '../../../../../src/graph/subgraphs/schedule/state.js';

function readyClient() {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-1'], status: 'resolved' };
  d.slots.staff = { value: 'stf-1', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  return d;
}

describe('assertSlotsResolved', () => {
  it('does not throw when all required slots resolved (client)', () => {
    expect(() => assertSlotsResolved(readyClient().slots, 'client')).not.toThrow();
  });

  it('throws invariant_violated when staff slot is empty', () => {
    const draft = readyClient();
    draft.slots.staff = { status: 'empty' };
    expect(() => assertSlotsResolved(draft.slots, 'client')).toThrow(IdpError);
    try {
      assertSlotsResolved(draft.slots, 'client');
    } catch (e) {
      expect((e as IdpError).code).toBe('invariant_violated');
    }
  });

  it('throws when status is guessed (not resolved)', () => {
    const draft = readyClient();
    draft.slots.services = { userPhrase: 'corte', status: 'guessed' };
    expect(() => assertSlotsResolved(draft.slots, 'client')).toThrow(IdpError);
  });

  it('throws when status resolved but value missing', () => {
    const draft = readyClient();
    draft.slots.date = { status: 'resolved' }; // value undefined
    expect(() => assertSlotsResolved(draft.slots, 'client')).toThrow(/value missing/);
  });

  it('throws when services value is empty array', () => {
    const draft = readyClient();
    draft.slots.services = { value: [], status: 'resolved' };
    expect(() => assertSlotsResolved(draft.slots, 'client')).toThrow(/non-empty/);
  });

  it('staff role: requires clientUuid slot to be resolved', () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = { value: ['svc-1'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-1', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    // clientUuid still empty
    expect(() => assertSlotsResolved(draft.slots, 'staff')).toThrow(/clientUuid/);
  });

  it('staff role: passes when clientUuid resolved with a value', () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = { value: ['svc-1'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-1', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    draft.slots.clientUuid = { value: 'client-uuid', status: 'resolved' };
    expect(() => assertSlotsResolved(draft.slots, 'staff')).not.toThrow();
  });
});
