import type { ConfirmDraftState } from './state.js';

/**
 * Reducer del subgrafo `confirm_appointment`. Slot único, sin gate, sin
 * availability cache.
 */
export function confirmSubgraphReducer(current: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (current === null || current === undefined) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const c = current as ConfirmDraftState;
  const n = next as Partial<ConfirmDraftState>;

  return {
    ...c,
    ...n,
    slots: { ...c.slots, ...(n.slots ?? {}) },
    meta: {
      attempts: c.meta.attempts + (n.meta?.attempts ?? 0),
      recoverableErrors: [...c.meta.recoverableErrors, ...(n.meta?.recoverableErrors ?? [])],
    },
    ...(n.terminalOutcome !== undefined ? { terminalOutcome: n.terminalOutcome } : {}),
  };
}
