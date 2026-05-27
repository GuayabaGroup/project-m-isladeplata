import { type BaseCheckpointSaver, END, START, StateGraph } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { AnthropicProvider } from '../infrastructure/llm/AnthropicProvider.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import { type GraphState, GraphStateAnnotation, type GraphStateUpdate } from './state.js';
import { detectButtonShortcut } from './supervisor/buttonShortcut.js';
import { makeClassifyIntentNode } from './supervisor/classifyIntent.js';
import { detectAtomicTool, routeFromSupervisor } from './supervisor/router.js';
import { makeSocialResponderNode } from './supervisor/socialResponder.js';
import type { AtomicTool, ToolDeps } from './tools/Tool.js';
import { forwardMessage } from './tools/support/forwardMessage.js';
import { connectMercadoPago } from './tools/system/connectMercadoPago.js';
import { generateVerificationUrl } from './tools/system/generateVerificationUrl.js';
import { retrieveManzanilloUrl } from './tools/system/retrieveManzanilloUrl.js';

export interface CompiledGraph {
  invoke(
    state: Partial<GraphState>,
    config: { configurable: { thread_id: string } },
  ): Promise<GraphState>;
}

export interface CompileGraphDeps {
  checkpointer: BaseCheckpointSaver;
  logger: Logger;
  llm: AnthropicProvider;
  guacuco: GuacucoClient;
}

/**
 * Compile the Isladeplata LangGraph (H3.B).
 *
 * Wiring:
 * ```
 *   START → supervisor_entry → [button shortcut?]
 *     ├── yes → subgraph_placeholder → END
 *     └── no  → classify_intent → router →
 *                 ├── social_responder        → END
 *                 ├── subgraph_placeholder    → END   (intent action+known / query)
 *                 └── tool_<name>             → END   (atomic tool via heuristic)
 * ```
 *
 * Subgrafos reales se enchufan en H4-H7. En H3.B todos caen al
 * `subgraph_placeholder` que devuelve un `handed_off` con texto "próximamente".
 */
export function compileGraph(deps: CompileGraphDeps): CompiledGraph {
  const { checkpointer, logger, llm, guacuco } = deps;

  const toolDeps: ToolDeps = { guacuco, logger };
  const classifyIntent = makeClassifyIntentNode({ llm, logger });
  const socialResponder = makeSocialResponderNode({ llm, logger });

  const wrap = (t: AtomicTool) => async (state: GraphState) => t.run(state, toolDeps);

  const compiled = new StateGraph(GraphStateAnnotation)
    .addNode('supervisor_entry', supervisorEntryNode)
    .addNode('classify_intent', classifyIntent)
    .addNode('social_responder', socialResponder)
    .addNode('subgraph_placeholder', subgraphPlaceholderNode)
    .addNode('tool_retrieve_manzanillo_url', wrap(retrieveManzanilloUrl))
    .addNode('tool_generate_verification_url', wrap(generateVerificationUrl))
    .addNode('tool_connect_mercado_pago', wrap(connectMercadoPago))
    .addNode('tool_forward_message', wrap(forwardMessage))
    .addEdge(START, 'supervisor_entry')
    .addConditionalEdges('supervisor_entry', supervisorEntryRouter, {
      subgraph_placeholder: 'subgraph_placeholder',
      classify_intent: 'classify_intent',
    })
    .addConditionalEdges('classify_intent', routeFromSupervisor, {
      social_responder: 'social_responder',
      subgraph_placeholder: 'subgraph_placeholder',
      tool_retrieve_manzanillo_url: 'tool_retrieve_manzanillo_url',
      tool_generate_verification_url: 'tool_generate_verification_url',
      tool_connect_mercado_pago: 'tool_connect_mercado_pago',
      tool_forward_message: 'tool_forward_message',
    })
    .addEdge('social_responder', END)
    .addEdge('subgraph_placeholder', END)
    .addEdge('tool_retrieve_manzanillo_url', END)
    .addEdge('tool_generate_verification_url', END)
    .addEdge('tool_connect_mercado_pago', END)
    .addEdge('tool_forward_message', END)
    .compile({ checkpointer });

  return {
    async invoke(state, config) {
      logger.debug('Graph invoke', { thread_id: config.configurable.thread_id });
      const result = await compiled.invoke(state as GraphState, config);
      return result as GraphState;
    },
  };
}

/**
 * Primer nodo del grafo. Detecta atajos (button payload) y pre-popula
 * `routing` con la decisión + opcional `targetTool` por heurística sobre el
 * texto crudo del usuario. NO llama al LLM.
 */
function supervisorEntryNode(state: GraphState): GraphStateUpdate {
  const message = state.input?.channelMessage;
  if (!message) return {};

  const shortcut = detectButtonShortcut(message.interactivePayload);
  if (shortcut) {
    return { routing: { buttonShortcut: shortcut } };
  }

  const text = sanitizeUserInput(message.contentText);
  const targetTool = text.length > 0 ? detectAtomicTool(text) : null;
  return targetTool ? { routing: { targetTool } } : {};
}

function supervisorEntryRouter(state: GraphState): 'subgraph_placeholder' | 'classify_intent' {
  return state.routing?.buttonShortcut ? 'subgraph_placeholder' : 'classify_intent';
}

/**
 * Placeholder para subgrafos no implementados en H3.B. Devuelve un
 * `handed_off` con texto explícito de "próximamente". Se reemplaza nodo a
 * nodo en H4-H7 cuando los subgrafos reales entren.
 */
function subgraphPlaceholderNode(state: GraphState): GraphStateUpdate {
  const subgraphName = inferSubgraphName(state);
  const outcome: Outcome = {
    action: 'handed_off',
    pendingReply: {
      text: `La funcionalidad de "${subgraphName}" todavía no está disponible. Un humano te va a contactar a la brevedad.`,
    },
  };
  return { outcome };
}

function inferSubgraphName(state: GraphState): string {
  const routing = state.routing ?? {};
  if (routing.buttonShortcut) {
    return routing.buttonShortcut.kind;
  }
  if (routing.messageType === 'query') return 'consulta';
  if (routing.intent && routing.intent !== 'unknown') return routing.intent;
  return 'esa acción';
}
