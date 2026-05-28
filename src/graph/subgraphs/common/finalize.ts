import type { Logger } from 'winston';
import type { Outcome } from '../../../core/types/Outcome.js';
import type { GraphStateUpdate } from '../../state.js';

/**
 * Nodo terminal genérico — copia `terminalOutcome` del subgraph state al
 * `outcome` global, limpia `subgraphState` y `routing.activeSubgraph`.
 *
 * Asume que TODO subgraph state tiene los campos `__kind`, `phase` y
 * `terminalOutcome?: Outcome`. El wrapper del parent compile.ts retorna
 * `Partial<GraphState>` listo para el merge final.
 */

interface MinimalSubgraphState {
  __kind?: string;
  phase?: string;
  terminalOutcome?: Outcome;
}

export interface FinalizeDeps {
  logger: Logger;
}

const DEFAULT_OUTCOME: Outcome = { action: 'ignored' };

export function makeSubgraphFinalizeNode(deps: FinalizeDeps) {
  const { logger } = deps;
  return function finalize(state: { subgraphState?: unknown }): GraphStateUpdate {
    const sub = state.subgraphState as MinimalSubgraphState | null | undefined;
    const outcome = sub?.terminalOutcome ?? DEFAULT_OUTCOME;
    logger.debug('subgraph.finalize', {
      kind: sub?.__kind,
      phase: sub?.phase,
      action: outcome.action,
    });
    return {
      outcome,
      subgraphState: null,
      routing: { activeSubgraph: undefined, intent: undefined, messageType: undefined },
    };
  };
}
