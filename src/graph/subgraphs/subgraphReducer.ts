/**
 * Reducer del slot `subgraphState` del parent graph. Despacha al merge correcto
 * según `__kind` (discriminador presente en cada subgraph state).
 *
 * Cuando un subgrafo nuevo entra (H6: reschedule, H7: query), agregar caso acá.
 */

import { cancelSubgraphReducer } from './cancel/reducer.js';
import { confirmSubgraphReducer } from './confirm/reducer.js';
import { querySubgraphReducer } from './query/reducer.js';
import { rescheduleSubgraphReducer } from './reschedule/reducer.js';
import { scheduleSubgraphReducer } from './schedule/reducer.js';

interface KindedState {
  __kind?: string;
}

export function subgraphReducerDispatch(current: unknown, next: unknown): unknown {
  // Reset explícito (finalize): borra el subgrafo.
  if (next === null) return null;

  // Detectar kind desde next (entry fresh) o current (mid-flow).
  const kind = pickKind(next) ?? pickKind(current);

  switch (kind) {
    case 'schedule':
      return scheduleSubgraphReducer(current, next);
    case 'confirm':
      return confirmSubgraphReducer(current, next);
    case 'cancel':
      return cancelSubgraphReducer(current, next);
    case 'reschedule':
      return rescheduleSubgraphReducer(current, next);
    case 'query':
      return querySubgraphReducer(current, next);
    default:
      // Sin discriminador: defaultea a replace. Cubre el primer entry
      // antes de que el subgrafo setee __kind, aunque en práctica los
      // dispatch nodes setean __kind explícitamente.
      return next;
  }
}

function pickKind(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const k = (value as KindedState).__kind;
  return typeof k === 'string' ? k : undefined;
}
