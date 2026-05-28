// Re-export del finalize común para mantener el import path del schedule.
// El comportamiento es idéntico: lee terminalOutcome del subgraph state y lo
// propaga al outcome global, limpia subgraphState + routing.activeSubgraph.
export {
  makeSubgraphFinalizeNode as makeScheduleFinalizeNode,
  type FinalizeDeps,
} from '../../common/finalize.js';
