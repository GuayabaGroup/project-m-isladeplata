import type { RescheduleDraftState } from './state.js';

/**
 * Reducer del subgrafo `reschedule_appointment`. Mismo patrón que schedule:
 * - `slots`: merge shallow.
 * - `availability` y `confirmation`: REEMPLAZO (el nodo retorna shape entero
 *   o no lo toca — permite a cancel_handler limpiar gate con `{confirmation: {}}`).
 * - `meta.attempts`: SUMA. `meta.recoverableErrors`: APPEND.
 * - `phase`, `terminalOutcome`: replace.
 */
export function rescheduleSubgraphReducer(current: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (current === null || current === undefined) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const c = current as RescheduleDraftState;
  const n = next as Partial<RescheduleDraftState>;

  return {
    ...c,
    ...n,
    slots: { ...c.slots, ...(n.slots ?? {}) },
    confirmation: n.confirmation !== undefined ? n.confirmation : c.confirmation,
    availability: n.availability !== undefined ? n.availability : c.availability,
    meta: {
      attempts: c.meta.attempts + (n.meta?.attempts ?? 0),
      recoverableErrors: [...c.meta.recoverableErrors, ...(n.meta?.recoverableErrors ?? [])],
    },
    ...(n.terminalOutcome !== undefined ? { terminalOutcome: n.terminalOutcome } : {}),
  };
}
