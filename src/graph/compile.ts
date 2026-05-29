import {
  type BaseCheckpointSaver,
  type Command,
  END,
  START,
  StateGraph,
  type StateSnapshot,
} from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import { env } from '../config/env.js';
import { QUERY_JUDGE_CONFIG } from '../config/llm.config.js';
import { IdpError } from '../core/errors/IdpError.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { LlmProvider } from '../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import { type GraphState, GraphStateAnnotation, type GraphStateUpdate } from './state.js';
// Cancel subgraph (H5)
import { makeCancelAskSlotNode } from './subgraphs/cancel/nodes/askSlot.js';
import { makeCancelBootstrapNode } from './subgraphs/cancel/nodes/bootstrap.js';
import { makeCancelBuildConfirmMessageNode } from './subgraphs/cancel/nodes/buildConfirmMessage.js';
import { makeCancelCommitNode } from './subgraphs/cancel/nodes/commit.js';
import { makeCancelGateConfirmNode } from './subgraphs/cancel/nodes/gateConfirm.js';
import { makeCancelSuccessNode } from './subgraphs/cancel/nodes/successResponse.js';
import { type CancelDraftState, initialCancelDraftState } from './subgraphs/cancel/state.js';
// Finalize compartido (H4 schedule lo re-exporta como makeScheduleFinalizeNode)
import { makeSubgraphFinalizeNode } from './subgraphs/common/finalize.js';
// Confirm subgraph (H5)
import { makeConfirmAskSlotNode } from './subgraphs/confirm/nodes/askSlot.js';
import { makeConfirmBootstrapNode } from './subgraphs/confirm/nodes/bootstrap.js';
import { makeConfirmCommitNode } from './subgraphs/confirm/nodes/commit.js';
import { makeConfirmSuccessNode } from './subgraphs/confirm/nodes/successResponse.js';
import { type ConfirmDraftState, initialConfirmDraftState } from './subgraphs/confirm/state.js';
// Query subgraph (H7)
import { makeClassifyQueryNode } from './subgraphs/query/nodes/classifyQuery.js';
import { makeFetchIntentNode } from './subgraphs/query/nodes/fetchIntent.js';
import { makeSynthesizeResponseNode } from './subgraphs/query/nodes/synthesizeResponse.js';
import { QueryJudge } from './subgraphs/query/queryJudge.js';
import { type QueryDraftState, initialQueryDraftState } from './subgraphs/query/state.js';
// Reschedule subgraph (H6)
import { makeRescheduleAskSlotNode } from './subgraphs/reschedule/nodes/askSlot.js';
import { makeRescheduleBootstrapNode } from './subgraphs/reschedule/nodes/bootstrap.js';
import { makeRescheduleBuildConfirmMessageNode } from './subgraphs/reschedule/nodes/buildConfirmMessage.js';
import { makeRescheduleCommitNode } from './subgraphs/reschedule/nodes/commit.js';
import { makeRescheduleGateConfirmNode } from './subgraphs/reschedule/nodes/gateConfirm.js';
import { makeReschedulePresentOptionsNode } from './subgraphs/reschedule/nodes/presentOptions.js';
import { makeRescheduleSuccessNode } from './subgraphs/reschedule/nodes/successResponse.js';
import { makeRescheduleValidateNode } from './subgraphs/reschedule/nodes/validateAvailability.js';
import {
  type RescheduleDraftState,
  initialRescheduleDraftState,
} from './subgraphs/reschedule/state.js';
import { makeAskSlotNode } from './subgraphs/schedule/nodes/askSlot.js';
import { makeBuildConfirmMessageNode } from './subgraphs/schedule/nodes/buildConfirmMessage.js';
import { checkCompleteness } from './subgraphs/schedule/nodes/checkCompleteness.js';
import { makeCommitNode } from './subgraphs/schedule/nodes/commit.js';
import { makeEntryNode as makeScheduleEntryNode } from './subgraphs/schedule/nodes/entry.js';
import { makeGateConfirmNode } from './subgraphs/schedule/nodes/gateConfirm.js';
import { makePresentOptionsNode } from './subgraphs/schedule/nodes/presentOptions.js';
import { makeResolveEntitiesNode } from './subgraphs/schedule/nodes/resolveEntities.js';
import { makeSuccessResponseNode } from './subgraphs/schedule/nodes/successResponse.js';
import { makeValidateAvailabilityNode } from './subgraphs/schedule/nodes/validateAvailability.js';
import {
  type AppointmentDraftState,
  initialAppointmentDraftState,
} from './subgraphs/schedule/state.js';
import { detectButtonShortcut } from './supervisor/buttonShortcut.js';
import { makeClassifyIntentNode } from './supervisor/classifyIntent.js';
import { detectAtomicTool, routeFromSupervisor } from './supervisor/router.js';
import { makeSocialResponderNode } from './supervisor/socialResponder.js';
import { detectUnsupportedContent } from './supervisor/unsupportedContent.js';
import type { AtomicTool, ToolDeps } from './tools/Tool.js';
import { forwardMessage } from './tools/support/forwardMessage.js';
import { connectMercadoPago } from './tools/system/connectMercadoPago.js';
import { generateVerificationUrl } from './tools/system/generateVerificationUrl.js';
import { retrieveManzanilloUrl } from './tools/system/retrieveManzanilloUrl.js';

export interface CompiledGraph {
  invoke(
    state: Partial<GraphState> | Command,
    config: { configurable: { thread_id: string } },
  ): Promise<GraphState>;
  /** Snapshot del state actual del thread — usado por el pipeline para
   * detectar interrupts pendientes y decidir invoke fresco vs resume. */
  getState(config: { configurable: { thread_id: string } }): Promise<StateSnapshot>;
}

export interface CompileGraphDeps {
  checkpointer: BaseCheckpointSaver;
  logger: Logger;
  llm: LlmProvider;
  guacuco: GuacucoClient;
}

/**
 * Compile the Isladeplata LangGraph (H4 — schedule subgraph integrado).
 *
 * Wiring:
 * ```
 *   START → supervisor_entry → [button shortcut?]
 *     ├── yes → subgraph_placeholder → END   (button sin subgrafo activo)
 *     └── no  → classify_intent → router →
 *                 ├── social_responder        → END
 *                 ├── tool_<name>             → END
 *                 ├── subgraph_placeholder    → END   (intent no implementado)
 *                 └── schedule_dispatch       → ...   (intent='schedule', H4)
 *
 *   Sub-flujo schedule (todos los nodos viven en el parent):
 *
 *   schedule_dispatch → schedule_entry → schedule_resolve →
 *     → check_completeness →
 *         ├── missing → schedule_ask_slot → [interrupt o loop] → resolve
 *         └── complete → validate_availability →
 *               ├── exactMatch → build_confirm → gate_confirm →
 *                     ├── confirm → commit →
 *                           ├── done → success_response → finalize → END
 *                           ├── validating_availability (race retry) → validate
 *                           └── failed → finalize → END
 *                     ├── cancel/text → resolve (loop con slot pisado)
 *                     └── failed → finalize → END
 *               ├── awaiting_pick → present_options →
 *                     ├── pick → build_confirm → ...
 *                     ├── text → resolve (re-parse)
 *                     └── failed → finalize → END
 *               └── failed → finalize → END
 * ```
 */
export function compileGraph(deps: CompileGraphDeps): CompiledGraph {
  const { checkpointer, logger, llm, guacuco } = deps;

  const toolDeps: ToolDeps = { guacuco, logger };
  const classifyIntent = makeClassifyIntentNode({ llm, logger });
  const socialResponder = makeSocialResponderNode({ llm, logger });

  // Schedule nodes (factory pattern: cada uno recibe deps + retorna node fn)
  const scheduleEntry = makeScheduleEntryNode({ llm, logger });
  const scheduleResolve = makeResolveEntitiesNode({ guacuco, logger });
  const scheduleAskSlot = makeAskSlotNode({ logger });
  const scheduleValidate = makeValidateAvailabilityNode({ guacuco, logger });
  const schedulePresent = makePresentOptionsNode({ logger });
  const scheduleBuildConfirm = makeBuildConfirmMessageNode({ llm, logger });
  const scheduleGate = makeGateConfirmNode({ logger });
  const scheduleCommit = makeCommitNode({ guacuco, logger });
  const scheduleSuccess = makeSuccessResponseNode({ llm, logger });

  // Confirm nodes
  const confirmBootstrap = makeConfirmBootstrapNode({ logger });
  const confirmAskSlot = makeConfirmAskSlotNode({ logger });
  const confirmCommit = makeConfirmCommitNode({ guacuco, logger });
  const confirmSuccess = makeConfirmSuccessNode({ llm, logger });

  // Cancel nodes
  const cancelBootstrap = makeCancelBootstrapNode({ logger });
  const cancelAskSlot = makeCancelAskSlotNode({ logger });
  const cancelBuildConfirm = makeCancelBuildConfirmMessageNode({ llm, logger });
  const cancelGate = makeCancelGateConfirmNode({ logger });
  const cancelCommit = makeCancelCommitNode({ guacuco, logger });
  const cancelSuccess = makeCancelSuccessNode({ llm, logger });

  // Reschedule nodes
  const rescheduleBootstrap = makeRescheduleBootstrapNode({ logger });
  const rescheduleAskSlot = makeRescheduleAskSlotNode({ logger });
  const rescheduleValidate = makeRescheduleValidateNode({ guacuco, logger });
  const reschedulePresent = makeReschedulePresentOptionsNode({ logger });
  const rescheduleBuildConfirm = makeRescheduleBuildConfirmMessageNode({ llm, logger });
  const rescheduleGate = makeRescheduleGateConfirmNode({ logger });
  const rescheduleCommit = makeRescheduleCommitNode({ guacuco, logger });
  const rescheduleSuccess = makeRescheduleSuccessNode({ llm, logger });

  // Query nodes (H7). QueryJudge (freeform_sql) opt-in vía env; undefined → skip.
  const queryJudge = env.QUERY_JUDGE_ENABLED
    ? new QueryJudge(llm, logger, QUERY_JUDGE_CONFIG)
    : undefined;
  const queryClassify = makeClassifyQueryNode({ llm, logger });
  const queryFetch = makeFetchIntentNode({
    guacuco,
    llm,
    logger,
    ...(queryJudge ? { judge: queryJudge } : {}),
  });
  const querySynthesize = makeSynthesizeResponseNode({
    llm,
    logger,
    ...(queryJudge ? { judge: queryJudge } : {}),
  });

  // Finalize compartido entre los 3 subgrafos.
  const subgraphFinalize = makeSubgraphFinalizeNode({ logger });

  // Wrap subgraph node fns: cada uno retorna Partial<TSubState>;
  // adaptamos a Partial<GraphState> con la actualización en `subgraphState`.
  // El reducer dispatch (`subgraphReducerDispatch`) rutea al merge por __kind.
  const wrapSchedule =
    <S extends { subgraphState?: unknown }, T>(fn: (s: S) => Partial<T>) =>
    async (state: GraphState): Promise<GraphStateUpdate> => {
      const update = fn(state as unknown as S);
      return { subgraphState: update };
    };

  const wrapScheduleAsync =
    <S extends { subgraphState?: unknown }, T>(fn: (s: S) => Promise<Partial<T>>) =>
    async (state: GraphState): Promise<GraphStateUpdate> => {
      try {
        const update = await fn(state as unknown as S);
        return { subgraphState: update };
      } catch (err) {
        // assertSlotsResolved lanza IdpError('invariant_violated') en commit.
        if (err instanceof IdpError && err.code === 'invariant_violated') {
          logger.error('Subgraph invariant violated', {
            code: err.code,
            message: err.message,
            details: err.details,
          });
          const terminalOutcome: Outcome = {
            action: 'error',
            pendingReply: {
              text: 'Tuve un problema interno. Un humano del equipo te va a contactar.',
            },
          };
          return {
            subgraphState: { phase: 'failed', terminalOutcome } as unknown,
          };
        }
        throw err;
      }
    };

  const wrapTool = (t: AtomicTool) => async (state: GraphState) => t.run(state, toolDeps);

  const compiled = new StateGraph(GraphStateAnnotation)
    .addNode('supervisor_entry', supervisorEntryNode)
    .addNode('classify_intent', classifyIntent)
    .addNode('social_responder', socialResponder)
    .addNode('subgraph_placeholder', subgraphPlaceholderNode)
    .addNode('tool_retrieve_manzanillo_url', wrapTool(retrieveManzanilloUrl))
    .addNode('tool_generate_verification_url', wrapTool(generateVerificationUrl))
    .addNode('tool_connect_mercado_pago', wrapTool(connectMercadoPago))
    .addNode('tool_forward_message', wrapTool(forwardMessage))
    // Schedule subgraph nodes (inlined en parent)
    .addNode('schedule_dispatch', scheduleDispatchNode)
    .addNode('schedule_entry', wrapScheduleAsync(scheduleEntry))
    .addNode('schedule_resolve', wrapScheduleAsync(scheduleResolve))
    .addNode('schedule_ask_slot', wrapSchedule(scheduleAskSlot))
    .addNode('schedule_validate', wrapScheduleAsync(scheduleValidate))
    .addNode('schedule_present', wrapSchedule(schedulePresent))
    .addNode('schedule_build_confirm', wrapScheduleAsync(scheduleBuildConfirm))
    .addNode('schedule_gate', wrapSchedule(scheduleGate))
    .addNode('schedule_commit', wrapScheduleAsync(scheduleCommit))
    .addNode('schedule_success', wrapScheduleAsync(scheduleSuccess))
    .addNode('schedule_finalize', subgraphFinalize)
    // Confirm subgraph nodes
    .addNode('confirm_dispatch', confirmDispatchNode)
    .addNode('confirm_bootstrap', wrapSchedule(confirmBootstrap))
    .addNode('confirm_ask_slot', wrapSchedule(confirmAskSlot))
    .addNode('confirm_commit', wrapScheduleAsync(confirmCommit))
    .addNode('confirm_success', wrapScheduleAsync(confirmSuccess))
    .addNode('confirm_finalize', subgraphFinalize)
    // Cancel subgraph nodes
    .addNode('cancel_dispatch', cancelDispatchNode)
    .addNode('cancel_bootstrap', wrapSchedule(cancelBootstrap))
    .addNode('cancel_ask_slot', wrapSchedule(cancelAskSlot))
    .addNode('cancel_build_confirm', wrapScheduleAsync(cancelBuildConfirm))
    .addNode('cancel_gate', wrapSchedule(cancelGate))
    .addNode('cancel_commit', wrapScheduleAsync(cancelCommit))
    .addNode('cancel_success', wrapScheduleAsync(cancelSuccess))
    .addNode('cancel_finalize', subgraphFinalize)
    // Reschedule subgraph nodes
    .addNode('reschedule_dispatch', rescheduleDispatchNode)
    .addNode('reschedule_bootstrap', wrapSchedule(rescheduleBootstrap))
    .addNode('reschedule_ask_slot', wrapSchedule(rescheduleAskSlot))
    .addNode('reschedule_validate', wrapScheduleAsync(rescheduleValidate))
    .addNode('reschedule_present', wrapSchedule(reschedulePresent))
    .addNode('reschedule_build_confirm', wrapScheduleAsync(rescheduleBuildConfirm))
    .addNode('reschedule_gate', wrapSchedule(rescheduleGate))
    .addNode('reschedule_commit', wrapScheduleAsync(rescheduleCommit))
    .addNode('reschedule_success', wrapScheduleAsync(rescheduleSuccess))
    .addNode('reschedule_finalize', subgraphFinalize)
    // Query subgraph nodes (H7)
    .addNode('query_dispatch', queryDispatchNode)
    .addNode('query_classify', wrapScheduleAsync(queryClassify))
    .addNode('query_fetch', wrapScheduleAsync(queryFetch))
    .addNode('query_synthesize', wrapScheduleAsync(querySynthesize))
    .addNode('query_finalize', subgraphFinalize)
    .addEdge(START, 'supervisor_entry')
    .addConditionalEdges('supervisor_entry', supervisorEntryRouter, {
      unsupported_end: END,
      subgraph_placeholder: 'subgraph_placeholder',
      classify_intent: 'classify_intent',
      schedule_dispatch: 'schedule_dispatch',
      confirm_dispatch: 'confirm_dispatch',
      cancel_dispatch: 'cancel_dispatch',
      reschedule_dispatch: 'reschedule_dispatch',
      query_dispatch: 'query_dispatch',
    })
    .addConditionalEdges('classify_intent', routeFromSupervisorWithSubgraphs, {
      social_responder: 'social_responder',
      subgraph_placeholder: 'subgraph_placeholder',
      schedule_dispatch: 'schedule_dispatch',
      confirm_dispatch: 'confirm_dispatch',
      cancel_dispatch: 'cancel_dispatch',
      reschedule_dispatch: 'reschedule_dispatch',
      query_dispatch: 'query_dispatch',
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
    // Schedule wiring
    .addEdge('schedule_dispatch', 'schedule_entry')
    .addEdge('schedule_entry', 'schedule_resolve')
    .addConditionalEdges('schedule_resolve', routeAfterResolve, {
      schedule_ask_slot: 'schedule_ask_slot',
      schedule_validate: 'schedule_validate',
      schedule_finalize: 'schedule_finalize',
    })
    .addConditionalEdges('schedule_ask_slot', routeAfterAskSlot, {
      schedule_resolve: 'schedule_resolve',
      schedule_finalize: 'schedule_finalize',
    })
    .addConditionalEdges('schedule_validate', routeAfterValidate, {
      schedule_build_confirm: 'schedule_build_confirm',
      schedule_present: 'schedule_present',
      schedule_finalize: 'schedule_finalize',
    })
    .addConditionalEdges('schedule_present', routeAfterPresent, {
      schedule_build_confirm: 'schedule_build_confirm',
      schedule_resolve: 'schedule_resolve',
      schedule_present: 'schedule_present',
      schedule_finalize: 'schedule_finalize',
    })
    .addEdge('schedule_build_confirm', 'schedule_gate')
    .addConditionalEdges('schedule_gate', routeAfterGate, {
      schedule_commit: 'schedule_commit',
      schedule_resolve: 'schedule_resolve',
      schedule_finalize: 'schedule_finalize',
    })
    .addConditionalEdges('schedule_commit', routeAfterCommit, {
      schedule_success: 'schedule_success',
      schedule_validate: 'schedule_validate',
      schedule_finalize: 'schedule_finalize',
    })
    .addEdge('schedule_success', 'schedule_finalize')
    .addEdge('schedule_finalize', END)
    // ===== Confirm wiring =====
    .addEdge('confirm_dispatch', 'confirm_bootstrap')
    .addConditionalEdges('confirm_bootstrap', routeAfterConfirmBootstrap, {
      confirm_ask_slot: 'confirm_ask_slot',
      confirm_commit: 'confirm_commit',
      confirm_finalize: 'confirm_finalize',
    })
    .addConditionalEdges('confirm_ask_slot', routeAfterConfirmAskSlot, {
      confirm_ask_slot: 'confirm_ask_slot',
      confirm_commit: 'confirm_commit',
      confirm_finalize: 'confirm_finalize',
    })
    .addConditionalEdges('confirm_commit', routeAfterConfirmCommit, {
      confirm_success: 'confirm_success',
      confirm_finalize: 'confirm_finalize',
    })
    .addEdge('confirm_success', 'confirm_finalize')
    .addEdge('confirm_finalize', END)
    // ===== Cancel wiring =====
    .addEdge('cancel_dispatch', 'cancel_bootstrap')
    .addConditionalEdges('cancel_bootstrap', routeAfterCancelBootstrap, {
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_build_confirm: 'cancel_build_confirm',
      cancel_finalize: 'cancel_finalize',
    })
    .addConditionalEdges('cancel_ask_slot', routeAfterCancelAskSlot, {
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_build_confirm: 'cancel_build_confirm',
      cancel_finalize: 'cancel_finalize',
    })
    .addEdge('cancel_build_confirm', 'cancel_gate')
    .addConditionalEdges('cancel_gate', routeAfterCancelGate, {
      cancel_commit: 'cancel_commit',
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_finalize: 'cancel_finalize',
    })
    .addConditionalEdges('cancel_commit', routeAfterCancelCommit, {
      cancel_success: 'cancel_success',
      cancel_finalize: 'cancel_finalize',
    })
    .addEdge('cancel_success', 'cancel_finalize')
    .addEdge('cancel_finalize', END)
    // ===== Reschedule wiring =====
    .addEdge('reschedule_dispatch', 'reschedule_bootstrap')
    .addConditionalEdges('reschedule_bootstrap', routeAfterRescheduleBootstrap, {
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addConditionalEdges('reschedule_ask_slot', routeAfterRescheduleAskSlot, {
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addConditionalEdges('reschedule_validate', routeAfterRescheduleValidate, {
      reschedule_build_confirm: 'reschedule_build_confirm',
      reschedule_present: 'reschedule_present',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addConditionalEdges('reschedule_present', routeAfterReschedulePresent, {
      reschedule_build_confirm: 'reschedule_build_confirm',
      reschedule_validate: 'reschedule_validate',
      reschedule_present: 'reschedule_present',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addEdge('reschedule_build_confirm', 'reschedule_gate')
    .addConditionalEdges('reschedule_gate', routeAfterRescheduleGate, {
      reschedule_commit: 'reschedule_commit',
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addConditionalEdges('reschedule_commit', routeAfterRescheduleCommit, {
      reschedule_success: 'reschedule_success',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'reschedule_finalize',
    })
    .addEdge('reschedule_success', 'reschedule_finalize')
    .addEdge('reschedule_finalize', END)
    // ===== Query wiring (H7) =====
    .addEdge('query_dispatch', 'query_classify')
    .addConditionalEdges('query_classify', routeAfterQueryClassify, {
      query_fetch: 'query_fetch',
      query_synthesize: 'query_synthesize',
      query_finalize: 'query_finalize',
    })
    .addConditionalEdges('query_fetch', routeAfterQueryFetch, {
      query_synthesize: 'query_synthesize',
      query_finalize: 'query_finalize',
    })
    .addEdge('query_synthesize', 'query_finalize')
    .addEdge('query_finalize', END)
    .compile({ checkpointer });

  return {
    async invoke(state, config) {
      logger.debug('Graph invoke', { thread_id: config.configurable.thread_id });
      // biome-ignore lint/suspicious/noExplicitAny: Command/state polymorphic
      const result = await (compiled as any).invoke(state, config);
      return result as GraphState;
    },
    async getState(config) {
      return compiled.getState(config);
    },
  };
}

// ============================================================================
// Supervisor entry: detecta button shortcut o heurística de tool atómica.
// Si hay subgrafo activo (`routing.activeSubgraph`), bypasea classifier y va
// directo al dispatch del subgrafo correspondiente.
// ============================================================================

type ActiveSubgraph = 'schedule' | 'confirm' | 'cancel' | 'reschedule' | 'query';

function supervisorEntryNode(state: GraphState): GraphStateUpdate {
  const message = state.input?.channelMessage;
  if (!message) return {};

  // Fast-path PRIMERO: contenido no soportado (image/audio/video/document/
  // location) → respuesta canned sin LLM. Va antes del guard de subgrafo
  // activo para que media a mitad de un flujo igual reciba respuesta.
  const unsupported = detectUnsupportedContent(message.contentType);
  if (unsupported) {
    return { outcome: unsupported };
  }

  // Si hay subgrafo activo, NO re-clasificamos — el resume va directo al
  // dispatcher correspondiente (que sabe cómo invocar el flujo interrumpido).
  // Query no interrumpe en el happy path, así que no debería ver active='query'
  // en el supervisor entry; defensa por si una future iteration lo agrega.
  const active = state.routing?.activeSubgraph as ActiveSubgraph | undefined;
  if (
    active === 'schedule' ||
    active === 'confirm' ||
    active === 'cancel' ||
    active === 'reschedule' ||
    active === 'query'
  ) {
    return { routing: { activeSubgraph: active } };
  }

  const shortcut = detectButtonShortcut(message.interactivePayload);
  if (shortcut) {
    return { routing: { buttonShortcut: shortcut } };
  }

  const text = sanitizeUserInput(message.contentText);
  const targetTool = text.length > 0 ? detectAtomicTool(text) : null;
  return targetTool ? { routing: { targetTool } } : {};
}

function supervisorEntryRouter(
  state: GraphState,
):
  | 'unsupported_end'
  | 'subgraph_placeholder'
  | 'classify_intent'
  | 'schedule_dispatch'
  | 'confirm_dispatch'
  | 'cancel_dispatch'
  | 'reschedule_dispatch'
  | 'query_dispatch' {
  // El nodo setea `outcome` solo en el fast-path de contenido no soportado.
  if (state.outcome) return 'unsupported_end';
  const active = state.routing?.activeSubgraph as ActiveSubgraph | undefined;
  if (active === 'schedule') return 'schedule_dispatch';
  if (active === 'confirm') return 'confirm_dispatch';
  if (active === 'cancel') return 'cancel_dispatch';
  if (active === 'reschedule') return 'reschedule_dispatch';
  if (active === 'query') return 'query_dispatch';
  return state.routing?.buttonShortcut ? 'subgraph_placeholder' : 'classify_intent';
}

/**
 * Wrap del router del supervisor para rutear schedule/confirm/cancel/reschedule/query
 * al dispatch real (en lugar del placeholder).
 */
function routeFromSupervisorWithSubgraphs(state: GraphState) {
  const base = routeFromSupervisor(state);
  if (base === 'subgraph_placeholder') {
    if (state.routing?.messageType === 'action') {
      const intent = state.routing.intent;
      if (intent === 'schedule') return 'schedule_dispatch' as const;
      if (intent === 'confirm') return 'confirm_dispatch' as const;
      if (intent === 'cancel') return 'cancel_dispatch' as const;
      if (intent === 'reschedule') return 'reschedule_dispatch' as const;
    }
    if (state.routing?.messageType === 'query') {
      return 'query_dispatch' as const;
    }
  }
  return base;
}

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
  if (routing.buttonShortcut) return routing.buttonShortcut.kind;
  if (routing.messageType === 'query') return 'consulta';
  if (routing.intent && routing.intent !== 'unknown') return routing.intent;
  return 'esa acción';
}

// ============================================================================
// Schedule dispatch: punto de entrada al sub-flujo. Inicializa subgraphState si
// es fresh, marca routing.activeSubgraph='schedule'.
// ============================================================================

function scheduleDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) {
    const outcome: Outcome = { action: 'ignored' };
    return { outcome };
  }
  // Si ya hay subgraphState (resume), no re-inicializar.
  if (state.subgraphState && (state.subgraphState as AppointmentDraftState).slots) {
    return { routing: { activeSubgraph: 'schedule' } };
  }
  return {
    routing: { activeSubgraph: 'schedule' },
    subgraphState: initialAppointmentDraftState(state.identity.profileType),
  };
}

// ============================================================================
// Conditional edge routers — leen subgraphState.phase y deciden próximo nodo.
// ============================================================================

function readDraft(state: GraphState): AppointmentDraftState | null {
  return (state.subgraphState as AppointmentDraftState | null) ?? null;
}

function routeAfterResolve(
  state: GraphState,
): 'schedule_ask_slot' | 'schedule_validate' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'schedule_finalize';
  const profileType = state.identity?.profileType ?? 'client';
  const missing = checkCompleteness(draft.slots, profileType);
  return missing === null ? 'schedule_validate' : 'schedule_ask_slot';
}

function routeAfterAskSlot(state: GraphState): 'schedule_resolve' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'schedule_finalize';
  return 'schedule_resolve';
}

function routeAfterValidate(
  state: GraphState,
): 'schedule_build_confirm' | 'schedule_present' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'schedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'schedule_build_confirm';
  if (draft.phase === 'awaiting_pick') return 'schedule_present';
  // Fallback (collecting / unexpected): vuelve a finalize (defensa)
  return 'schedule_finalize';
}

function routeAfterPresent(
  state: GraphState,
): 'schedule_build_confirm' | 'schedule_resolve' | 'schedule_present' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'schedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'schedule_build_confirm';
  if (draft.phase === 'collecting') return 'schedule_resolve';
  if (draft.phase === 'awaiting_pick') return 'schedule_present';
  return 'schedule_finalize';
}

function routeAfterGate(
  state: GraphState,
): 'schedule_commit' | 'schedule_resolve' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'schedule_finalize';
  if (draft.phase === 'committing') return 'schedule_commit';
  if (draft.phase === 'collecting') return 'schedule_resolve';
  return 'schedule_finalize';
}

function routeAfterCommit(
  state: GraphState,
): 'schedule_success' | 'schedule_validate' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) {
    // Failed (or no draft) → finalize sin success response.
    // (commit setea terminalOutcome cuando falla, finalize lo propaga al outcome global)
    return 'schedule_finalize';
  }
  if (draft.phase === 'validating_availability') return 'schedule_validate';
  if (draft.phase === 'done') return 'schedule_success';
  return 'schedule_finalize';
}

// ============================================================================
// Confirm subgraph dispatch + routers
// ============================================================================

function confirmDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) return { outcome: { action: 'ignored' } };
  if (state.subgraphState && (state.subgraphState as ConfirmDraftState).__kind === 'confirm') {
    return { routing: { activeSubgraph: 'confirm' } };
  }
  return {
    routing: { activeSubgraph: 'confirm' },
    subgraphState: initialConfirmDraftState(),
  };
}

function readConfirmDraft(state: GraphState): ConfirmDraftState | null {
  const sub = state.subgraphState as ConfirmDraftState | null;
  if (sub?.__kind !== 'confirm') return null;
  return sub;
}

function routeAfterConfirmBootstrap(
  state: GraphState,
): 'confirm_ask_slot' | 'confirm_commit' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'confirm_finalize';
  if (draft.phase === 'committing') return 'confirm_commit';
  if (draft.phase === 'collecting') return 'confirm_ask_slot';
  return 'confirm_finalize';
}

function routeAfterConfirmAskSlot(
  state: GraphState,
): 'confirm_ask_slot' | 'confirm_commit' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'confirm_finalize';
  if (draft.phase === 'committing') return 'confirm_commit';
  // collecting: slot todavía empty/guessed → loop a ask_slot
  return 'confirm_ask_slot';
}

function routeAfterConfirmCommit(state: GraphState): 'confirm_success' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'confirm_finalize';
  if (draft.phase === 'done') return 'confirm_success';
  return 'confirm_finalize';
}

// ============================================================================
// Cancel subgraph dispatch + routers
// ============================================================================

function cancelDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) return { outcome: { action: 'ignored' } };
  if (state.subgraphState && (state.subgraphState as CancelDraftState).__kind === 'cancel') {
    return { routing: { activeSubgraph: 'cancel' } };
  }
  return {
    routing: { activeSubgraph: 'cancel' },
    subgraphState: initialCancelDraftState(),
  };
}

function readCancelDraft(state: GraphState): CancelDraftState | null {
  const sub = state.subgraphState as CancelDraftState | null;
  if (sub?.__kind !== 'cancel') return null;
  return sub;
}

function routeAfterCancelBootstrap(
  state: GraphState,
): 'cancel_ask_slot' | 'cancel_build_confirm' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'cancel_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'cancel_build_confirm';
  if (draft.phase === 'collecting') return 'cancel_ask_slot';
  return 'cancel_finalize';
}

function routeAfterCancelAskSlot(
  state: GraphState,
): 'cancel_ask_slot' | 'cancel_build_confirm' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'cancel_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'cancel_build_confirm';
  return 'cancel_ask_slot';
}

function routeAfterCancelGate(
  state: GraphState,
): 'cancel_commit' | 'cancel_ask_slot' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'cancel_finalize';
  if (draft.phase === 'committing') return 'cancel_commit';
  if (draft.phase === 'collecting') return 'cancel_ask_slot';
  return 'cancel_finalize';
}

function routeAfterCancelCommit(state: GraphState): 'cancel_success' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'cancel_finalize';
  if (draft.phase === 'done') return 'cancel_success';
  return 'cancel_finalize';
}

// ============================================================================
// Reschedule subgraph dispatch + routers (H6)
// ============================================================================

function rescheduleDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) return { outcome: { action: 'ignored' } };
  if (
    state.subgraphState &&
    (state.subgraphState as RescheduleDraftState).__kind === 'reschedule'
  ) {
    return { routing: { activeSubgraph: 'reschedule' } };
  }
  return {
    routing: { activeSubgraph: 'reschedule' },
    subgraphState: initialRescheduleDraftState(),
  };
}

function readRescheduleDraft(state: GraphState): RescheduleDraftState | null {
  const sub = state.subgraphState as RescheduleDraftState | null;
  if (sub?.__kind !== 'reschedule') return null;
  return sub;
}

function routeAfterRescheduleBootstrap(
  state: GraphState,
): 'reschedule_ask_slot' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  return decideAfterCollecting(draft);
}

function routeAfterRescheduleAskSlot(
  state: GraphState,
): 'reschedule_ask_slot' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  return decideAfterCollecting(draft);
}

function decideAfterCollecting(
  draft: RescheduleDraftState,
): 'reschedule_ask_slot' | 'reschedule_validate' {
  const { appointmentUuid, newDate, newTime } = draft.slots;
  const allResolved =
    appointmentUuid.status === 'resolved' &&
    !!appointmentUuid.value &&
    newDate.status === 'resolved' &&
    !!newDate.value &&
    newTime.status === 'resolved' &&
    !!newTime.value;
  return allResolved ? 'reschedule_validate' : 'reschedule_ask_slot';
}

function routeAfterRescheduleValidate(
  state: GraphState,
): 'reschedule_build_confirm' | 'reschedule_present' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'reschedule_build_confirm';
  if (draft.phase === 'awaiting_pick') return 'reschedule_present';
  return 'reschedule_finalize';
}

function routeAfterReschedulePresent(
  state: GraphState,
):
  | 'reschedule_build_confirm'
  | 'reschedule_validate'
  | 'reschedule_present'
  | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'reschedule_build_confirm';
  if (draft.phase === 'collecting') return 'reschedule_validate';
  if (draft.phase === 'awaiting_pick') return 'reschedule_present';
  return 'reschedule_finalize';
}

function routeAfterRescheduleGate(
  state: GraphState,
): 'reschedule_commit' | 'reschedule_ask_slot' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  if (draft.phase === 'committing') return 'reschedule_commit';
  if (draft.phase === 'collecting') return 'reschedule_ask_slot';
  return 'reschedule_finalize';
}

function routeAfterRescheduleCommit(
  state: GraphState,
): 'reschedule_success' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'reschedule_finalize';
  if (draft.phase === 'validating_availability') return 'reschedule_validate';
  if (draft.phase === 'done') return 'reschedule_success';
  return 'reschedule_finalize';
}

// ============================================================================
// Query subgraph dispatch + routers (H7)
// ============================================================================

function queryDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) return { outcome: { action: 'ignored' } };
  // Si ya hay state (poco probable — query no interrumpe en happy path),
  // preservar para no perder fetch en curso.
  if (state.subgraphState && (state.subgraphState as QueryDraftState).__kind === 'query') {
    return { routing: { activeSubgraph: 'query' } };
  }
  const userText = sanitizeUserInput(state.input?.channelMessage?.contentText ?? '');
  return {
    routing: { activeSubgraph: 'query' },
    subgraphState: initialQueryDraftState(userText),
  };
}

function readQueryDraft(state: GraphState): QueryDraftState | null {
  const sub = state.subgraphState as QueryDraftState | null;
  if (sub?.__kind !== 'query') return null;
  return sub;
}

function routeAfterQueryClassify(
  state: GraphState,
): 'query_fetch' | 'query_synthesize' | 'query_finalize' {
  const draft = readQueryDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'query_finalize';
  if (draft.phase === 'fetching') return 'query_fetch';
  if (draft.phase === 'synthesizing') return 'query_synthesize';
  return 'query_finalize';
}

function routeAfterQueryFetch(state: GraphState): 'query_synthesize' | 'query_finalize' {
  const draft = readQueryDraft(state);
  if (!draft || draft.phase === 'failed' || draft.terminalOutcome) return 'query_finalize';
  if (draft.phase === 'synthesizing') return 'query_synthesize';
  return 'query_finalize';
}
