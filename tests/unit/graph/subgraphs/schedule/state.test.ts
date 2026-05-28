import { describe, expect, it } from 'vitest';
import {
  appendErrors,
  initialAppointmentDraftState,
  requiredSlots,
  sumAttempts,
} from '../../../../../src/graph/subgraphs/schedule/state.js';

describe('initialAppointmentDraftState', () => {
  it('returns 4 empty slots for client', () => {
    const s = initialAppointmentDraftState('client');
    expect(s.slots.services.status).toBe('empty');
    expect(s.slots.staff.status).toBe('empty');
    expect(s.slots.date.status).toBe('empty');
    expect(s.slots.time.status).toBe('empty');
    expect(s.slots.clientUuid).toBeUndefined();
  });

  it('includes clientUuid slot for staff', () => {
    const s = initialAppointmentDraftState('staff');
    expect(s.slots.clientUuid).toBeDefined();
    expect(s.slots.clientUuid?.status).toBe('empty');
  });

  it('starts in resolving_entities phase with empty meta', () => {
    const s = initialAppointmentDraftState('client');
    expect(s.phase).toBe('resolving_entities');
    expect(s.meta.attempts).toBe(0);
    expect(s.meta.recoverableErrors).toEqual([]);
  });

  it('has empty availability cache and confirmation', () => {
    const s = initialAppointmentDraftState('client');
    expect(s.availability.proposedSlots).toEqual([]);
    expect(s.availability.exactMatch).toBeUndefined();
    expect(s.confirmation.intentUuid).toBeUndefined();
  });
});

describe('requiredSlots', () => {
  it('client requires services, staff, date, time', () => {
    expect(requiredSlots('client')).toEqual(['services', 'staff', 'date', 'time']);
  });

  it('staff requires clientUuid in addition', () => {
    expect(requiredSlots('staff')).toEqual(['services', 'staff', 'date', 'time', 'clientUuid']);
  });
});

describe('reducers', () => {
  it('sumAttempts adds', () => {
    expect(sumAttempts(2, 1)).toBe(3);
    expect(sumAttempts(0, 1)).toBe(1);
  });

  it('appendErrors appends', () => {
    expect(appendErrors(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(appendErrors([], ['x'])).toEqual(['x']);
  });
});
