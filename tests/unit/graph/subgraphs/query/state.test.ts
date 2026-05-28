import { describe, expect, it } from 'vitest';
import { querySubgraphReducer } from '../../../../../src/graph/subgraphs/query/reducer.js';
import {
  type QueryDraftState,
  initialQueryDraftState,
} from '../../../../../src/graph/subgraphs/query/state.js';

describe('query initial state', () => {
  it('preserves userText, sets __kind+phase, empty meta', () => {
    const s = initialQueryDraftState('cuánto cuesta corte');
    expect(s.__kind).toBe('query');
    expect(s.userText).toBe('cuánto cuesta corte');
    expect(s.phase).toBe('classifying');
    expect(s.intent).toBeUndefined();
    expect(s.rawResult).toBeUndefined();
    expect(s.meta.attempts).toBe(0);
  });
});

describe('querySubgraphReducer', () => {
  it('returns null when next is null (finalize)', () => {
    expect(querySubgraphReducer(initialQueryDraftState('x'), null)).toBeNull();
  });

  it('returns next when current is null/undefined (entry)', () => {
    const next = initialQueryDraftState('hola');
    expect(querySubgraphReducer(null, next)).toBe(next);
    expect(querySubgraphReducer(undefined, next)).toBe(next);
  });

  it('replaces phase/intent/rawResult when next provides them', () => {
    const current = initialQueryDraftState('precios');
    const merged = querySubgraphReducer(current, {
      intent: 'service_prices',
      confidence: 0.95,
      phase: 'fetching',
    }) as QueryDraftState;
    expect(merged.intent).toBe('service_prices');
    expect(merged.confidence).toBe(0.95);
    expect(merged.phase).toBe('fetching');
    expect(merged.userText).toBe('precios');
  });

  it('replaces rawResult on next pass', () => {
    const current: QueryDraftState = {
      ...initialQueryDraftState('q'),
      rawResult: { services: [] },
    };
    const merged = querySubgraphReducer(current, {
      rawResult: { services: [{ name: 'Corte', price: 5000 }] },
    }) as QueryDraftState;
    expect(merged.rawResult).toEqual({ services: [{ name: 'Corte', price: 5000 }] });
  });

  it('sums meta.attempts and appends recoverableErrors', () => {
    const current = initialQueryDraftState('q');
    current.meta = { attempts: 1, recoverableErrors: ['e1'] };
    const merged = querySubgraphReducer(current, {
      meta: { attempts: 1, recoverableErrors: ['e2'] },
    }) as QueryDraftState;
    expect(merged.meta.attempts).toBe(2);
    expect(merged.meta.recoverableErrors).toEqual(['e1', 'e2']);
  });

  it('replaces terminalOutcome when set in next', () => {
    const current = initialQueryDraftState('q');
    const merged = querySubgraphReducer(current, {
      phase: 'done',
      terminalOutcome: { action: 'response', pendingReply: { text: 'ok' } },
    }) as QueryDraftState;
    expect(merged.phase).toBe('done');
    expect(merged.terminalOutcome?.action).toBe('response');
  });
});
