import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Outcome } from '../core/types/Outcome.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import { type GraphState, GraphStateAnnotation, type GraphStateUpdate } from './state.js';

export interface CompiledGraph {
  invoke(
    state: Partial<GraphState>,
    config: { configurable: { thread_id: string } },
  ): Promise<GraphState>;
}

export interface CompileGraphDeps {
  checkpointer: BaseCheckpointSaver;
  logger: Logger;
}

/**
 * Compile the Isladeplata LangGraph.
 *
 * **H3.A version**: single `echo` node that produces the same outcome as
 * `EchoResponder` did pre-H3. Validates the wiring (state + checkpointer +
 * invoke + thread_id) end-to-end without LLM yet.
 *
 * **H3.B**: this is replaced by `supervisor + tools + subgraphs`. The
 * `invoke` contract stays the same so `pregraph/pipeline.ts` won't need
 * to change.
 */
export function compileGraph(deps: CompileGraphDeps): CompiledGraph {
  const { checkpointer, logger } = deps;

  const builder = new StateGraph(GraphStateAnnotation)
    .addNode('echo', echoNode)
    .addEdge(START, 'echo')
    .addEdge('echo', END);

  const compiled = builder.compile({ checkpointer });

  return {
    async invoke(state, config) {
      logger.debug('Graph invoke', { thread_id: config.configurable.thread_id });
      const result = await compiled.invoke(state as GraphState, config);
      return result as GraphState;
    },
  };
}

function echoNode(state: GraphState): GraphStateUpdate {
  const message = state.input?.channelMessage;
  const identity = state.identity;
  if (!message || !identity) {
    const ignored: Outcome = { action: 'ignored' };
    return { outcome: ignored };
  }
  const text = sanitizeUserInput(message.contentText);
  const role = identity.profileType === 'staff' ? 'staff' : 'cliente';
  const replyText =
    text.length > 0
      ? `[grafo] Recibido (${role}): "${text}"`
      : `[grafo] Recibido (${role}): [mensaje vacío]`;
  const outcome: Outcome = {
    action: 'response',
    pendingReply: { text: replyText },
  };
  return { outcome };
}
