import { describe, expect, it } from 'vitest';
import { initialCancelDraftState } from '../../../../src/graph/subgraphs/cancel/state.js';
import { initialConfirmDraftState } from '../../../../src/graph/subgraphs/confirm/state.js';
import { initialAppointmentDraftState } from '../../../../src/graph/subgraphs/schedule/state.js';
import { subgraphReducerDispatch } from '../../../../src/graph/subgraphs/subgraphReducer.js';

describe('subgraphReducerDispatch', () => {
  it('null next clears state', () => {
    const current = initialAppointmentDraftState('client');
    expect(subgraphReducerDispatch(current, null)).toBeNull();
  });

  it('routes schedule shape to scheduleSubgraphReducer (slots merge)', () => {
    const current = initialAppointmentDraftState('client');
    const next = { slots: { staff: { value: 'stf-1', status: 'resolved' } } };
    const merged = subgraphReducerDispatch(current, next) as typeof current;
    expect(merged.__kind).toBe('schedule');
    expect(merged.slots.staff.value).toBe('stf-1');
    // services slot preserved (slots is shallow-merged in scheduleSubgraphReducer)
    expect(merged.slots.services).toBeDefined();
  });

  it('routes confirm shape to confirmSubgraphReducer', () => {
    const current = initialConfirmDraftState();
    const next = {
      slots: { appointmentUuid: { value: 'apt-1', status: 'resolved' } },
      phase: 'committing' as const,
    };
    const merged = subgraphReducerDispatch(current, next) as typeof current;
    expect(merged.__kind).toBe('confirm');
    expect(merged.slots.appointmentUuid.value).toBe('apt-1');
    expect(merged.phase).toBe('committing');
  });

  it('routes cancel shape to cancelSubgraphReducer (confirmation replace)', () => {
    const current = {
      ...initialCancelDraftState(),
      confirmation: { intentUuid: 'old-uuid', message: 'old' },
    };
    const next = { confirmation: {} };
    const merged = subgraphReducerDispatch(current, next) as typeof current;
    expect(merged.confirmation.intentUuid).toBeUndefined();
    expect(merged.confirmation.message).toBeUndefined();
  });

  it('falls back to replace when no __kind discriminator', () => {
    const current = { foo: 1 };
    const next = { bar: 2 };
    expect(subgraphReducerDispatch(current, next)).toEqual(next);
  });

  it('infers kind from current when next has no __kind', () => {
    const current = initialAppointmentDraftState('client');
    const next = { phase: 'collecting' as const };
    const merged = subgraphReducerDispatch(current, next) as typeof current;
    expect(merged.__kind).toBe('schedule');
    expect(merged.phase).toBe('collecting');
  });
});
