import { describe, expect, it } from 'vitest';
import { rescheduleSubgraphReducer } from '../../../../../src/graph/subgraphs/reschedule/reducer.js';
import {
  type RescheduleDraftState,
  initialRescheduleDraftState,
} from '../../../../../src/graph/subgraphs/reschedule/state.js';

describe('reschedule initial state', () => {
  it('all slots empty, phase collecting, __kind reschedule', () => {
    const s = initialRescheduleDraftState();
    expect(s.__kind).toBe('reschedule');
    expect(s.slots.appointmentUuid.status).toBe('empty');
    expect(s.slots.newDate.status).toBe('empty');
    expect(s.slots.newTime.status).toBe('empty');
    expect(s.phase).toBe('collecting');
    expect(s.availability.proposedSlots).toEqual([]);
    expect(s.confirmation).toEqual({});
    expect(s.meta.attempts).toBe(0);
  });
});

describe('rescheduleSubgraphReducer', () => {
  it('returns null when next is null', () => {
    expect(rescheduleSubgraphReducer(initialRescheduleDraftState(), null)).toBeNull();
  });

  it('returns next when current is null/undefined (entry)', () => {
    const next = initialRescheduleDraftState();
    expect(rescheduleSubgraphReducer(null, next)).toBe(next);
    expect(rescheduleSubgraphReducer(undefined, next)).toBe(next);
  });

  it('merges slots shallow (only updates the changed slot)', () => {
    const current = initialRescheduleDraftState();
    current.slots.appointmentUuid = { value: 'apt-1', status: 'resolved' };
    const merged = rescheduleSubgraphReducer(current, {
      slots: { newDate: { value: '2026-06-05', status: 'resolved' } },
    }) as RescheduleDraftState;
    expect(merged.slots.appointmentUuid.value).toBe('apt-1');
    expect(merged.slots.newDate.value).toBe('2026-06-05');
    expect(merged.slots.newTime.status).toBe('empty');
  });

  it('replaces availability when next provides it', () => {
    const current = initialRescheduleDraftState();
    current.availability = {
      lastCheckedFor: { appointmentUuid: 'apt-1', newDate: '2026-06-05', newTime: '10:00' },
      exactMatch: true,
      proposedSlots: [],
    };
    const merged = rescheduleSubgraphReducer(current, {
      availability: { proposedSlots: [] },
    }) as RescheduleDraftState;
    expect(merged.availability.exactMatch).toBeUndefined();
    expect(merged.availability.lastCheckedFor).toBeUndefined();
  });

  it('replaces confirmation when next provides it (gate cleanup pattern)', () => {
    const current = initialRescheduleDraftState();
    current.confirmation = { intentUuid: 'intent-1', message: 'msg' };
    const merged = rescheduleSubgraphReducer(current, {
      confirmation: {},
    }) as RescheduleDraftState;
    expect(merged.confirmation).toEqual({});
  });

  it('sums meta.attempts and appends recoverableErrors', () => {
    const current = initialRescheduleDraftState();
    current.meta = { attempts: 2, recoverableErrors: ['e1'] };
    const merged = rescheduleSubgraphReducer(current, {
      meta: { attempts: 1, recoverableErrors: ['e2'] },
    }) as RescheduleDraftState;
    expect(merged.meta.attempts).toBe(3);
    expect(merged.meta.recoverableErrors).toEqual(['e1', 'e2']);
  });

  it('replaces phase and terminalOutcome when next provides them', () => {
    const current = initialRescheduleDraftState();
    const merged = rescheduleSubgraphReducer(current, {
      phase: 'failed',
      terminalOutcome: { action: 'error' },
    }) as RescheduleDraftState;
    expect(merged.phase).toBe('failed');
    expect(merged.terminalOutcome?.action).toBe('error');
  });
});
