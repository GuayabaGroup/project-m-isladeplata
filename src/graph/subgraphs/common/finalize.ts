import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../core/types/ChannelMessage.js';
import type { Outcome } from '../../../core/types/Outcome.js';
import type { ToolCallRecord } from '../../../core/types/ToolCall.js';
import { sanitizeUserInput } from '../../../security/sanitize.js';
import type { GraphStateUpdate } from '../../state.js';

/**
 * Nodo terminal genérico — copia `terminalOutcome` del subgraph state al
 * `outcome` global, limpia `subgraphState` y `routing.activeSubgraph`.
 *
 * Asume que TODO subgraph state tiene los campos `__kind`, `phase` y
 * `terminalOutcome?: Outcome`. El wrapper del parent compile.ts retorna
 * `Partial<GraphState>` listo para el merge final.
 *
 * **Historial conversacional**: cuando el turno cierra con una respuesta de
 * texto, appendea el par `[HumanMessage(pregunta), AIMessage(respuesta)]` a
 * `state.messages` (cap aplicado por el reducer). Esto alimenta la resolución
 * de anáforas del subgrafo query en turnos siguientes ("¿y la próxima?",
 * "dame detalles") — único lugar donde se acumula historial. Los turnos que
 * cierran por `interrupt()` (ask_slot/gate/present de los subgrafos write) NO
 * pasan por acá y no se registran; es aceptable porque las anáforas son
 * follow-ups de consultas, no de trámites a medio completar.
 */

interface MinimalSubgraphState {
  __kind?: string;
  phase?: string;
  terminalOutcome?: Outcome;
  meta?: { toolCalls?: ToolCallRecord[] };
}

export interface FinalizeDeps {
  logger: Logger;
}

const DEFAULT_OUTCOME: Outcome = { action: 'ignored' };

export function makeSubgraphFinalizeNode(deps: FinalizeDeps) {
  const { logger } = deps;
  return function finalize(state: {
    subgraphState?: unknown;
    input?: { channelMessage?: ChannelMessage } | null;
  }): GraphStateUpdate {
    const sub = state.subgraphState as MinimalSubgraphState | null | undefined;
    const baseOutcome = sub?.terminalOutcome ?? DEFAULT_OUTCOME;
    // Propaga las tools ejecutadas en el turno (acumuladas en meta.toolCalls por
    // los commits) al outcome global, para que el pipeline las persista (P2).
    const toolCalls = sub?.meta?.toolCalls;
    const outcome: Outcome =
      toolCalls && toolCalls.length > 0 ? { ...baseOutcome, toolCalls } : baseOutcome;
    logger.debug('subgraph.finalize', {
      kind: sub?.__kind,
      phase: sub?.phase,
      action: outcome.action,
      toolCalls: toolCalls?.length ?? 0,
    });

    const base: GraphStateUpdate = {
      outcome,
      subgraphState: null,
      routing: { activeSubgraph: undefined, intent: undefined, messageType: undefined },
    };

    // Registrar el par user/assistant del turno para historial (anáforas).
    // Solo cuando hubo intercambio de texto real — evita turnos colgados.
    const userText = sanitizeUserInput(state.input?.channelMessage?.contentText ?? '');
    const replyText = outcome.pendingReply?.text ?? '';
    if (userText.length > 0 && replyText.length > 0) {
      return {
        ...base,
        messages: [new HumanMessage(userText), new AIMessage(replyText)],
      };
    }
    return base;
  };
}
