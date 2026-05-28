import type { CancelDraftState } from './state.js';

/**
 * Reducer del subgrafo `cancel_appointment`. Slot único + gate de confirmación.
 * `confirmation` se REEMPLAZA (no merge) — un nodo retorna el shape entero o
 * no lo toca; permite que `cancel_handler` limpie con `{confirmation: {}}`.
 */
export function cancelSubgraphReducer(current: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (current === null || current === undefined) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const c = current as CancelDraftState;
  const n = next as Partial<CancelDraftState>;

  return {
    ...c,
    ...n,
    slots: { ...c.slots, ...(n.slots ?? {}) },
    confirmation: n.confirmation !== undefined ? n.confirmation : c.confirmation,
    meta: {
      attempts: c.meta.attempts + (n.meta?.attempts ?? 0),
      recoverableErrors: [...c.meta.recoverableErrors, ...(n.meta?.recoverableErrors ?? [])],
    },
    ...(n.terminalOutcome !== undefined ? { terminalOutcome: n.terminalOutcome } : {}),
  };
}
