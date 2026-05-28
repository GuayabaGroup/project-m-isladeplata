import { mergeSubgraphMeta } from '../common/state.js';
import type { AppointmentDraftState } from './state.js';

/**
 * Reducer custom para el slot `subgraphState` del parent graph cuando el
 * subgrafo activo es `schedule`. Cada nodo del subgrafo retorna actualizaciones
 * parciales y este reducer las mergea respetando la ownership por campo.
 *
 * Reglas:
 * - `slots`: merge shallow (cada slot se reemplaza si viene en next).
 * - `confirmation` y `availability`: se REEMPLAZAN cuando next los trae
 *   (los nodos retornan el shape completo o no lo tocan). Esto es clave
 *   para que `cancel_handler` pueda limpiar con `{confirmation: {}}`.
 * - `meta.attempts`: SUMA (los nodos retornan delta con `{meta: {attempts: 1}}`).
 * - `meta.recoverableErrors`: APPEND.
 * - `phase`, `terminalOutcome`: replace si vienen en next.
 *
 * Cuando current es null (primer entry) → retorna next tal cual.
 * Cuando next es null → retorna null (limpia, salida del subgrafo).
 */

export function scheduleSubgraphReducer(current: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (current === null || current === undefined) return next;
  if (typeof current !== 'object' || typeof next !== 'object') return next;

  const c = current as AppointmentDraftState;
  const n = next as Partial<AppointmentDraftState>;

  return {
    ...c,
    ...n,
    slots: { ...c.slots, ...(n.slots ?? {}) },
    confirmation: n.confirmation !== undefined ? n.confirmation : c.confirmation,
    availability: n.availability !== undefined ? n.availability : c.availability,
    meta: mergeSubgraphMeta(c.meta, n.meta),
    ...(n.terminalOutcome !== undefined ? { terminalOutcome: n.terminalOutcome } : {}),
  };
}
