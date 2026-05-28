import type { QueryDraftState } from './state.js';

/**
 * Reducer del subgrafo `query`. Más simple que los write-subgraphs: no hay
 * slots ni confirmation. Phase/intent/rawResult se replazan; meta suma.
 */
export function querySubgraphReducer(current: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (current === null || current === undefined) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const c = current as QueryDraftState;
  const n = next as Partial<QueryDraftState>;

  return {
    ...c,
    ...n,
    meta: {
      attempts: c.meta.attempts + (n.meta?.attempts ?? 0),
      recoverableErrors: [...c.meta.recoverableErrors, ...(n.meta?.recoverableErrors ?? [])],
    },
    ...(n.terminalOutcome !== undefined ? { terminalOutcome: n.terminalOutcome } : {}),
  };
}
