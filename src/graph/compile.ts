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
import type { PlatformContentLoader } from '../infrastructure/content/PlatformContentLoader.js';
import type { LlmProvider } from '../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import {
  type GraphState,
  GraphStateAnnotation,
  type GraphStateUpdate,
  type RoutingState,
} from './state.js';
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
import type { SlotState } from './subgraphs/common/state.js';
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
import {
  type ButtonShortcut,
  detectButtonShortcut,
  detectTemplateButtonShortcut,
  resolveTemplateAppointmentUuid,
} from './supervisor/buttonShortcut.js';
import { makeClassifyIntentNode } from './supervisor/classifyIntent.js';
import { makeFrustrationJudge } from './supervisor/detectFrustration.js';
import { detectAtomicTool, routeFromSupervisor } from './supervisor/router.js';
import { makeSocialResponderNode } from './supervisor/socialResponder.js';
import { detectUnsupportedContent } from './supervisor/unsupportedContent.js';
import type { AtomicTool, ToolDeps } from './tools/Tool.js';
import { forwardMessage } from './tools/support/forwardMessage.js';
import { connectMercadoPago } from './tools/system/connectMercadoPago.js';
import { retrieveManzanilloUrl } from './tools/system/retrieveManzanilloUrl.js';
import { sendClientSummary } from './tools/system/sendClientSummary.js';

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
  /** Loader de contenido de plataforma (Nivel B, H9.2). Inyectado a `fetchIntent`
   * para los intents `platform_commercial`/`platform_onboarding`. Opcional:
   * undefined → `fetchIntent` trata todo como "sin contenido" y escala a soporte
   * (default seguro; bootstrap siempre lo inyecta). */
  platformContent?: PlatformContentLoader;
}

/**
 * Compile the Isladeplata LangGraph (H4 — schedule subgraph integrado).
 *
 * Wiring (nodos compartidos: `subgraph_dispatch`, `subgraph_gate`,
 * `subgraph_finalize` — un solo nodo c/u, despachan por subgrafo activo / `__kind`
 * para no inflar el conteo de nodos del StateGraph; ver comentarios en el body):
 * ```
 *   START → supervisor_entry → [button shortcut?]
 *     ├── yes → subgraph_placeholder → END   (button stale/huérfano sin subgrafo activo)
 *     │      o → subgraph_dispatch / tool_send_client_summary  (tap de template)
 *     └── no  → classify_intent → router →
 *                 ├── social_responder        → END
 *                 ├── tool_<name>             → END
 *                 ├── subgraph_placeholder    → END   (defensa: intent allowed sin dispatch)
 *                 └── subgraph_dispatch       → primer nodo del subgrafo destino
 *
 *   subgraph_dispatch → routeAfterDispatch → {schedule_entry | confirm_bootstrap |
 *     cancel_bootstrap | reschedule_bootstrap | query_classify}
 *
 *   Sub-flujo schedule (todos los nodos viven en el parent):
 *
 *   schedule_entry → schedule_resolve →
 *     → check_completeness →
 *         ├── missing → schedule_ask_slot → [interrupt o loop] → resolve
 *         └── complete → validate_availability →
 *               ├── exactMatch → build_confirm → subgraph_gate →
 *                     ├── confirm → commit →
 *                           ├── done → success_response → subgraph_finalize → END
 *                           ├── validating_availability (race retry) → validate
 *                           └── failed → subgraph_finalize → END
 *                     ├── cancel/text → resolve (loop con slot pisado)
 *                     └── failed → subgraph_finalize → END
 *               ├── awaiting_pick → present_options →
 *                     ├── pick → build_confirm → ...
 *                     ├── text → resolve (re-parse)
 *                     └── failed → subgraph_finalize → END
 *               └── failed → subgraph_finalize → END
 * ```
 */
export function compileGraph(deps: CompileGraphDeps): CompiledGraph {
  const { checkpointer, logger, llm, guacuco, platformContent } = deps;

  const toolDeps: ToolDeps = { guacuco, logger, llm };

  // Takeover humano (spec P-human-takeover). No agrega nodos al grafo: capa A
  // reusa el clasificador (`humanRequestEnabled` → emite el messageType
  // `human_request`) y capa C es el juez de frustración inyectado en el mismo
  // clasificador (`frustrationJudge`, en su propio flag). Ambas rutean a
  // `social_responder`, que reconoce `human_request` y emite el handoff canned +
  // la señal `outcome.takeover`. Con HUMAN_TAKEOVER_ENABLED=false el clasificador
  // nunca emite `human_request` → comportamiento idéntico al de antes del takeover.
  const takeoverEnabled = env.HUMAN_TAKEOVER_ENABLED;
  const sentimentEnabled = takeoverEnabled && env.TAKEOVER_SENTIMENT_ENABLED;

  const classifyIntent = makeClassifyIntentNode({
    llm,
    logger,
    humanRequestEnabled: takeoverEnabled,
    // Capa C: el juez se inyecta solo cuando el flag de sentimiento está on.
    ...(sentimentEnabled ? { frustrationJudge: makeFrustrationJudge({ llm, logger }) } : {}),
  });
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
    platformContent,
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

  // Gate de confirmación UNIFICADO. schedule/cancel/reschedule comparten el
  // patrón "construir confirmación → gatear sí/no"; antes eran 3 nodos `*_gate`
  // distintos. Se colapsan en `subgraph_gate`, que despacha por `__kind` al gate
  // del subgrafo activo. (confirm NO tiene gate.) Reduce el conteo de nodos del
  // StateGraph (techo TS2589). Las 3 funciones de gate quedan intactas; solo el
  // routing (entrada por `*_build_confirm`, salida por `routeAfterSubgraphGate`)
  // se centraliza.
  const scheduleGateNode = wrapSchedule(scheduleGate);
  const cancelGateNode = wrapSchedule(cancelGate);
  const rescheduleGateNode = wrapSchedule(rescheduleGate);
  const subgraphGateNode = (state: GraphState): Promise<GraphStateUpdate> => {
    const kind = (state.subgraphState as { __kind?: ActiveSubgraph } | null)?.__kind;
    if (kind === 'cancel') return cancelGateNode(state);
    if (kind === 'reschedule') return rescheduleGateNode(state);
    return scheduleGateNode(state);
  };

  // Dos nodos compartidos colapsan repetición que antes inflaba el conteo de
  // nodos del StateGraph (el chain `.addNode` roza el techo de profundidad de
  // instanciación de tipos de TS — TS2589):
  //   - `subgraph_finalize`: los 5 `*_finalize` registraban la MISMA
  //     `subgraphFinalize`; un solo nodo basta (handler genérico vía `__kind`).
  //   - `subgraph_dispatch`: los 5 `*_dispatch` eran casi idénticos (init del
  //     draft + `activeSubgraph`); uno solo deriva el destino y despacha.
  //   - `subgraph_gate`: ver arriba.
  // Seguro porque por turno hay un solo subgrafo activo → una sola arista entrante
  // dispara. Los routers condicionales por-subgrafo NO cambian — siguen devolviendo
  // sus keys `*_finalize`/`*_commit`/…, que los mapas de abajo apuntan al nodo real.
  const builder = new StateGraph(GraphStateAnnotation)
    .addNode('supervisor_entry', supervisorEntryNode)
    .addNode('classify_intent', classifyIntent)
    .addNode('social_responder', socialResponder)
    .addNode('subgraph_placeholder', subgraphPlaceholderNode)
    .addNode('subgraph_dispatch', subgraphDispatchNode)
    .addNode('subgraph_gate', subgraphGateNode)
    .addNode('subgraph_finalize', subgraphFinalize)
    .addNode('tool_retrieve_manzanillo_url', wrapTool(retrieveManzanilloUrl))
    .addNode('tool_connect_mercado_pago', wrapTool(connectMercadoPago))
    .addNode('tool_send_client_summary', wrapTool(sendClientSummary))
    .addNode('tool_forward_message', wrapTool(forwardMessage))
    // Schedule subgraph nodes (inlined en parent)
    .addNode('schedule_entry', wrapScheduleAsync(scheduleEntry))
    .addNode('schedule_resolve', wrapScheduleAsync(scheduleResolve))
    .addNode('schedule_ask_slot', wrapSchedule(scheduleAskSlot))
    .addNode('schedule_validate', wrapScheduleAsync(scheduleValidate))
    .addNode('schedule_present', wrapSchedule(schedulePresent))
    .addNode('schedule_build_confirm', wrapScheduleAsync(scheduleBuildConfirm))
    .addNode('schedule_commit', wrapScheduleAsync(scheduleCommit))
    .addNode('schedule_success', wrapScheduleAsync(scheduleSuccess))
    // Confirm subgraph nodes
    .addNode('confirm_bootstrap', wrapSchedule(confirmBootstrap))
    .addNode('confirm_ask_slot', wrapSchedule(confirmAskSlot))
    .addNode('confirm_commit', wrapScheduleAsync(confirmCommit))
    .addNode('confirm_success', wrapScheduleAsync(confirmSuccess))
    // Cancel subgraph nodes
    .addNode('cancel_bootstrap', wrapSchedule(cancelBootstrap))
    .addNode('cancel_ask_slot', wrapSchedule(cancelAskSlot))
    .addNode('cancel_build_confirm', wrapScheduleAsync(cancelBuildConfirm))
    .addNode('cancel_commit', wrapScheduleAsync(cancelCommit))
    .addNode('cancel_success', wrapScheduleAsync(cancelSuccess))
    // Reschedule subgraph nodes
    .addNode('reschedule_bootstrap', wrapSchedule(rescheduleBootstrap))
    .addNode('reschedule_ask_slot', wrapSchedule(rescheduleAskSlot))
    .addNode('reschedule_validate', wrapScheduleAsync(rescheduleValidate))
    .addNode('reschedule_present', wrapSchedule(reschedulePresent))
    .addNode('reschedule_build_confirm', wrapScheduleAsync(rescheduleBuildConfirm))
    .addNode('reschedule_commit', wrapScheduleAsync(rescheduleCommit))
    .addNode('reschedule_success', wrapScheduleAsync(rescheduleSuccess))
    // Query subgraph nodes (H7)
    .addNode('query_classify', wrapScheduleAsync(queryClassify))
    .addNode('query_fetch', wrapScheduleAsync(queryFetch))
    .addNode('query_synthesize', wrapScheduleAsync(querySynthesize));

  const compiled = builder
    .addEdge(START, 'supervisor_entry')
    .addConditionalEdges('supervisor_entry', supervisorEntryRouter, {
      unsupported_end: END,
      subgraph_placeholder: 'subgraph_placeholder',
      classify_intent: 'classify_intent',
      subgraph_dispatch: 'subgraph_dispatch',
      tool_send_client_summary: 'tool_send_client_summary',
    })
    .addConditionalEdges('classify_intent', routeFromSupervisorWithSubgraphs, {
      social_responder: 'social_responder',
      subgraph_placeholder: 'subgraph_placeholder',
      subgraph_dispatch: 'subgraph_dispatch',
      tool_retrieve_manzanillo_url: 'tool_retrieve_manzanillo_url',
      tool_connect_mercado_pago: 'tool_connect_mercado_pago',
      tool_forward_message: 'tool_forward_message',
    })
    .addEdge('social_responder', END)
    .addEdge('subgraph_placeholder', END)
    .addEdge('subgraph_finalize', END)
    .addEdge('tool_retrieve_manzanillo_url', END)
    .addEdge('tool_connect_mercado_pago', END)
    .addEdge('tool_send_client_summary', END)
    .addEdge('tool_forward_message', END)
    // Dispatch unificado → primer nodo del subgrafo activo.
    .addConditionalEdges('subgraph_dispatch', routeAfterDispatch, {
      schedule_entry: 'schedule_entry',
      confirm_bootstrap: 'confirm_bootstrap',
      cancel_bootstrap: 'cancel_bootstrap',
      reschedule_bootstrap: 'reschedule_bootstrap',
      query_classify: 'query_classify',
      subgraph_finalize: 'subgraph_finalize',
    })
    // Gate unificado → delega al router del gate del subgrafo activo (por __kind).
    .addConditionalEdges('subgraph_gate', routeAfterSubgraphGate, {
      schedule_commit: 'schedule_commit',
      schedule_resolve: 'schedule_resolve',
      schedule_finalize: 'subgraph_finalize',
      cancel_commit: 'cancel_commit',
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_finalize: 'subgraph_finalize',
      reschedule_commit: 'reschedule_commit',
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_finalize: 'subgraph_finalize',
    })
    // Schedule wiring
    .addEdge('schedule_entry', 'schedule_resolve')
    .addConditionalEdges('schedule_resolve', routeAfterResolve, {
      schedule_ask_slot: 'schedule_ask_slot',
      schedule_validate: 'schedule_validate',
      schedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('schedule_ask_slot', routeAfterAskSlot, {
      schedule_resolve: 'schedule_resolve',
      schedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('schedule_validate', routeAfterValidate, {
      schedule_build_confirm: 'schedule_build_confirm',
      schedule_present: 'schedule_present',
      schedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('schedule_present', routeAfterPresent, {
      schedule_build_confirm: 'schedule_build_confirm',
      schedule_resolve: 'schedule_resolve',
      schedule_present: 'schedule_present',
      schedule_finalize: 'subgraph_finalize',
    })
    .addEdge('schedule_build_confirm', 'subgraph_gate')
    .addConditionalEdges('schedule_commit', routeAfterCommit, {
      schedule_success: 'schedule_success',
      schedule_validate: 'schedule_validate',
      schedule_finalize: 'subgraph_finalize',
    })
    .addEdge('schedule_success', 'subgraph_finalize')
    // ===== Confirm wiring =====
    .addConditionalEdges('confirm_bootstrap', routeAfterConfirmBootstrap, {
      confirm_ask_slot: 'confirm_ask_slot',
      confirm_commit: 'confirm_commit',
      confirm_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('confirm_ask_slot', routeAfterConfirmAskSlot, {
      confirm_ask_slot: 'confirm_ask_slot',
      confirm_commit: 'confirm_commit',
      confirm_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('confirm_commit', routeAfterConfirmCommit, {
      confirm_success: 'confirm_success',
      confirm_finalize: 'subgraph_finalize',
    })
    .addEdge('confirm_success', 'subgraph_finalize')
    // ===== Cancel wiring =====
    .addConditionalEdges('cancel_bootstrap', routeAfterCancelBootstrap, {
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_build_confirm: 'cancel_build_confirm',
      cancel_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('cancel_ask_slot', routeAfterCancelAskSlot, {
      cancel_ask_slot: 'cancel_ask_slot',
      cancel_build_confirm: 'cancel_build_confirm',
      cancel_finalize: 'subgraph_finalize',
    })
    .addEdge('cancel_build_confirm', 'subgraph_gate')
    .addConditionalEdges('cancel_commit', routeAfterCancelCommit, {
      cancel_success: 'cancel_success',
      cancel_finalize: 'subgraph_finalize',
    })
    .addEdge('cancel_success', 'subgraph_finalize')
    // ===== Reschedule wiring =====
    .addConditionalEdges('reschedule_bootstrap', routeAfterRescheduleBootstrap, {
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('reschedule_ask_slot', routeAfterRescheduleAskSlot, {
      reschedule_ask_slot: 'reschedule_ask_slot',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('reschedule_validate', routeAfterRescheduleValidate, {
      reschedule_build_confirm: 'reschedule_build_confirm',
      reschedule_present: 'reschedule_present',
      reschedule_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('reschedule_present', routeAfterReschedulePresent, {
      reschedule_build_confirm: 'reschedule_build_confirm',
      reschedule_validate: 'reschedule_validate',
      reschedule_present: 'reschedule_present',
      reschedule_finalize: 'subgraph_finalize',
    })
    .addEdge('reschedule_build_confirm', 'subgraph_gate')
    .addConditionalEdges('reschedule_commit', routeAfterRescheduleCommit, {
      reschedule_success: 'reschedule_success',
      reschedule_validate: 'reschedule_validate',
      reschedule_finalize: 'subgraph_finalize',
    })
    .addEdge('reschedule_success', 'subgraph_finalize')
    // ===== Query wiring (H7) =====
    .addConditionalEdges('query_classify', routeAfterQueryClassify, {
      query_fetch: 'query_fetch',
      query_synthesize: 'query_synthesize',
      query_finalize: 'subgraph_finalize',
    })
    .addConditionalEdges('query_fetch', routeAfterQueryFetch, {
      query_synthesize: 'query_synthesize',
      query_finalize: 'subgraph_finalize',
    })
    .addEdge('query_synthesize', 'subgraph_finalize')
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

/**
 * Campos de `routing` que son PER-TURNO: el supervisor los recomputa en cada
 * turno (atajo button, heurística de tool, salida del classifier). Como el canal
 * `routing` se mergea y persiste en el checkpoint (`mergeRouting`, state.ts), si
 * no se limpian sobreviven y contaminan el turno siguiente. El caso real
 * observado: un `buttonShortcut` de un tap previo ("Cancelar cita") sobrevive y
 * desvía un texto libre posterior a `subgraph_placeholder` → "Esa opción ya no
 * está disponible…", en vez de dejar que el classifier interprete el mensaje.
 *
 * Se limpian al ABRIR el turno (mismo espíritu que el reset de `outcome`).
 * `activeSubgraph`/`handoff` NO van acá: son estado de flujo cross-turno (resume);
 * `finalize` es quien limpia `activeSubgraph` al completar un subgrafo.
 */
const ROUTING_TURN_RESET: Partial<RoutingState> = {
  buttonShortcut: undefined,
  targetTool: undefined,
  messageType: undefined,
  intent: undefined,
  confidence: undefined,
  takeoverReason: undefined,
};

function supervisorEntryNode(state: GraphState): GraphStateUpdate {
  const message = state.input?.channelMessage;
  if (!message) return {};

  // Reset del outcome stale al ABRIR el turno. `outcome` es un canal persistido
  // en el checkpoint y NO se limpia entre turnos; en un invoke fresh (no-resume)
  // conserva el valor del turno anterior. Sin este reset, `supervisorEntryRouter`
  // lo confunde con el fast-path de contenido no soportado de ESTE turno y
  // cortocircuita a END re-emitiendo la respuesta previa byte-por-byte. (§8.2: el
  // supervisor es owner de `outcome` en los fast-paths / apertura de turno.) El
  // fast-path de media de abajo pisa este null con su propio outcome.
  const turnReset: GraphStateUpdate = { outcome: null };

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
    return { ...turnReset, routing: { ...ROUTING_TURN_RESET, activeSubgraph: active } };
  }

  // Botones de templates de Guacuco (recordatorios): la acción se deriva del
  // título visible, NO del prefijo del payload (que puede venir cruzado por un
  // desalineo de orden en Meta). Botones interactivos propios del IDP: por prefijo.
  const shortcut =
    message.contentType === 'template_button'
      ? detectTemplateButtonShortcut(message.interactivePayload)
      : detectButtonShortcut(message.interactivePayload);
  if (shortcut) {
    // El payload de un quick-reply de template es estático (el título), no trae el
    // uuid del turno. Lo resolvemos cruzando el `contextMessageId` del tap contra
    // los `recentTemplates` (mismo origen que el resolver de Guacuco por
    // `meta_message_id`). Si no se resuelve, el `value` queda como está y el subgrafo
    // cae a su lógica actual (preguntar) — nunca a un turno arbitrario.
    let finalShortcut = shortcut;
    if (message.contentType === 'template_button' && typeof shortcut.value === 'string') {
      const resolved = resolveTemplateAppointmentUuid(
        message.templateButton?.contextMessageId,
        state.recentTemplates ?? [],
      );
      if (resolved) finalShortcut = { ...shortcut, value: resolved };
    }
    return { ...turnReset, routing: { ...ROUTING_TURN_RESET, buttonShortcut: finalShortcut } };
  }

  const text = sanitizeUserInput(message.contentText);
  const targetTool = text.length > 0 ? detectAtomicTool(text) : null;
  return targetTool
    ? { ...turnReset, routing: { ...ROUTING_TURN_RESET, targetTool } }
    : { ...turnReset, routing: { ...ROUTING_TURN_RESET } };
}

function supervisorEntryRouter(
  state: GraphState,
):
  | 'unsupported_end'
  | 'subgraph_placeholder'
  | 'classify_intent'
  | 'subgraph_dispatch'
  | 'tool_send_client_summary' {
  // `supervisorEntryNode` resetea el `outcome` stale del checkpoint al abrir el
  // turno, así que un `outcome` presente acá solo puede venir del fast-path de
  // contenido no soportado de ESTE turno → cortocircuito a END.
  if (state.outcome) return 'unsupported_end';
  // Resume de subgrafo activo → el dispatch unificado deriva cuál y reanuda.
  const active = state.routing?.activeSubgraph as ActiveSubgraph | undefined;
  if (
    active === 'schedule' ||
    active === 'confirm' ||
    active === 'cancel' ||
    active === 'reschedule' ||
    active === 'query'
  ) {
    return 'subgraph_dispatch';
  }

  // Button shortcut en FRÍO (sin subgrafo activo). Solo los taps sobre botones de
  // TEMPLATE proactivo (recordatorio 24h) lanzan su subgrafo: confirm/cancel/
  // reschedule despachan pre-sembrando el turno desde el payload. Un botón
  // interactivo confirm:/cancel: sin subgrafo activo es un gate stale/huérfano (o
  // un pick intra-flujo) → placeholder, no re-ejecuta la acción.
  const shortcut = state.routing?.buttonShortcut;
  if (shortcut) {
    const isTemplateTap = state.input?.channelMessage?.contentType === 'template_button';
    if (isTemplateTap) {
      if (
        shortcut.kind === 'confirm' ||
        shortcut.kind === 'cancel' ||
        shortcut.kind === 'reschedule'
      ) {
        return 'subgraph_dispatch';
      }
      // Tool atómica single-turn: no abre subgrafo, ejecuta y responde.
      if (shortcut.kind === 'client_summary') return 'tool_send_client_summary';
    }
    return 'subgraph_placeholder';
  }
  return 'classify_intent';
}

/**
 * Wrap del router del supervisor para rutear schedule/confirm/cancel/reschedule/query
 * al dispatch real (en lugar del placeholder).
 */
function routeFromSupervisorWithSubgraphs(state: GraphState) {
  const base = routeFromSupervisor(state);
  if (base === 'subgraph_placeholder') {
    // El subgrafo concreto lo deriva `subgraph_dispatch` (mismo signal: intent /
    // messageType). Acá solo decidimos "es un subgrafo" vs el resto.
    if (state.routing?.messageType === 'action') {
      const intent = state.routing.intent;
      if (
        intent === 'schedule' ||
        intent === 'confirm' ||
        intent === 'cancel' ||
        intent === 'reschedule'
      ) {
        return 'subgraph_dispatch' as const;
      }
    }
    if (state.routing?.messageType === 'query') {
      return 'subgraph_dispatch' as const;
    }
  }
  return base;
}

/**
 * Nodo de fallback. Hoy (H4-H9 completos) NO representa "feature no
 * implementada" — todos los subgrafos existen. Se alcanza en la práctica por
 * **un tap de botón stale/huérfano sin subgrafo activo** que lo reciba
 * (`supervisorEntryRouter` con `buttonShortcut` y sin `activeSubgraph`), y como
 * defensa ante un intent allowed que no tenga dispatch mapeado.
 *
 * Por eso: `action: 'response'` (NO `handed_off` — un botón viejo no debe
 * escalar a un humano ni contar como falla del bot en `TakeoverStore`) y un
 * mensaje que invita a reformular en vez de prometer contacto humano.
 */
function subgraphPlaceholderNode(): GraphStateUpdate {
  const outcome: Outcome = {
    action: 'response',
    pendingReply: {
      text: 'Esa opción ya no está disponible. Contame qué necesitás y te ayudo. 🙂',
    },
  };
  return { outcome };
}

// ============================================================================
// Dispatch UNIFICADO: un solo nodo inicializa el subgraphState del subgrafo
// destino (o lo preserva en resume) y setea `routing.activeSubgraph`. Reemplaza
// los 5 `*_dispatch` casi idénticos. El destino se deriva de los MISMOS signals
// que ya usaban los routers de entrada; la salida (`routeAfterDispatch`) va al
// primer nodo real del subgrafo. La pre-siembra del slot de cita
// (`preseedAppointmentSlot`) se aplica a confirm/cancel/reschedule igual que antes.
// ============================================================================

/**
 * Deriva a qué subgrafo despachar a partir del `routing` ya resuelto por el
 * supervisor. Orden de precedencia idéntico al de los routers de entrada:
 * resume (`activeSubgraph`) → tap de botón de template (`buttonShortcut`
 * confirm/cancel/reschedule) → salida del classifier (intent de acción /
 * `messageType='query'`). `null` solo en paths no alcanzables (los routers de
 * entrada ya gatean: solo rutean a `subgraph_dispatch` con destino válido y
 * permitido por rol).
 */
function resolveDispatchTarget(state: GraphState): ActiveSubgraph | null {
  const active = state.routing?.activeSubgraph as ActiveSubgraph | undefined;
  if (active) return active;

  const shortcut = state.routing?.buttonShortcut;
  if (
    shortcut?.kind === 'confirm' ||
    shortcut?.kind === 'cancel' ||
    shortcut?.kind === 'reschedule'
  ) {
    return shortcut.kind;
  }

  if (state.routing?.messageType === 'action') {
    const intent = state.routing.intent;
    if (
      intent === 'schedule' ||
      intent === 'confirm' ||
      intent === 'cancel' ||
      intent === 'reschedule'
    ) {
      return intent;
    }
  }
  if (state.routing?.messageType === 'query') return 'query';
  return null;
}

function subgraphDispatchNode(state: GraphState): GraphStateUpdate {
  if (!state.identity) return { outcome: { action: 'ignored' } };

  const target = resolveDispatchTarget(state);
  if (!target) return { outcome: { action: 'ignored' } };

  // Resume: ya hay subgraphState del mismo kind → no re-inicializar.
  const existing = state.subgraphState as { __kind?: ActiveSubgraph } | null;
  if (existing?.__kind === target) {
    return { routing: { activeSubgraph: target } };
  }

  // Fresh: inicializa el draft del subgrafo destino. Los write con cita
  // (confirm/cancel/reschedule) pre-siembran el slot desde el tap de recordatorio.
  switch (target) {
    case 'schedule':
      return {
        routing: { activeSubgraph: 'schedule' },
        subgraphState: initialAppointmentDraftState(state.identity.profileType),
      };
    case 'confirm': {
      const subgraphState = initialConfirmDraftState();
      preseedAppointmentSlot(subgraphState.slots, state.routing?.buttonShortcut, 'confirm');
      return { routing: { activeSubgraph: 'confirm' }, subgraphState };
    }
    case 'cancel': {
      const subgraphState = initialCancelDraftState();
      preseedAppointmentSlot(subgraphState.slots, state.routing?.buttonShortcut, 'cancel');
      return { routing: { activeSubgraph: 'cancel' }, subgraphState };
    }
    case 'reschedule': {
      const subgraphState = initialRescheduleDraftState();
      preseedAppointmentSlot(subgraphState.slots, state.routing?.buttonShortcut, 'reschedule');
      return { routing: { activeSubgraph: 'reschedule' }, subgraphState };
    }
    case 'query': {
      const userText = sanitizeUserInput(state.input?.channelMessage?.contentText ?? '');
      return {
        routing: { activeSubgraph: 'query' },
        subgraphState: initialQueryDraftState(userText),
      };
    }
  }
}

/**
 * Edge de salida del dispatch unificado: al primer nodo real del subgrafo activo.
 * `subgraph_finalize` como defensa si no quedó `activeSubgraph` (ej. dispatch
 * abortó por falta de identity → outcome `ignored`).
 */
function routeAfterDispatch(
  state: GraphState,
):
  | 'schedule_entry'
  | 'confirm_bootstrap'
  | 'cancel_bootstrap'
  | 'reschedule_bootstrap'
  | 'query_classify'
  | 'subgraph_finalize' {
  const active = state.routing?.activeSubgraph as ActiveSubgraph | undefined;
  switch (active) {
    case 'schedule':
      return 'schedule_entry';
    case 'confirm':
      return 'confirm_bootstrap';
    case 'cancel':
      return 'cancel_bootstrap';
    case 'reschedule':
      return 'reschedule_bootstrap';
    case 'query':
      return 'query_classify';
    default:
      return 'subgraph_finalize';
  }
}

// ============================================================================
// Conditional edge routers — leen subgraphState.phase y deciden próximo nodo.
// ============================================================================

/**
 * Type guard compartido por todos los routers condicionales: el draft existe,
 * no falló, y no tiene `terminalOutcome` pendiente → el subgrafo sigue activo.
 * Usado como `if (!isActiveDraft(draft)) return '*_finalize'` para que TS
 * estreche `draft` a no-null tras el guard. Centraliza el predicado que ~20
 * routers repetían inline.
 */
function isActiveDraft<T extends { phase?: string; terminalOutcome?: unknown }>(
  draft: T | null | undefined,
): draft is T {
  return !!draft && draft.phase !== 'failed' && !draft.terminalOutcome;
}

function readDraft(state: GraphState): AppointmentDraftState | null {
  return (state.subgraphState as AppointmentDraftState | null) ?? null;
}

/**
 * Factory de lectores de draft por `__kind`: devuelve el subgraphState tipado
 * solo si su discriminador coincide, sino `null`. Centraliza el patrón idéntico
 * de confirm/cancel/reschedule/query. (schedule usa su propio `readDraft` sin
 * `__kind` por ser el primer subgrafo.)
 */
function makeReadDraft<T extends { __kind: string }>(kind: T['__kind']) {
  return (state: GraphState): T | null => {
    const sub = state.subgraphState as T | null;
    return sub?.__kind === kind ? sub : null;
  };
}

function routeAfterResolve(
  state: GraphState,
): 'schedule_ask_slot' | 'schedule_validate' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) return 'schedule_finalize';
  const profileType = state.identity?.profileType ?? 'client';
  const missing = checkCompleteness(draft.slots, profileType);
  return missing === null ? 'schedule_validate' : 'schedule_ask_slot';
}

function routeAfterAskSlot(state: GraphState): 'schedule_resolve' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) return 'schedule_finalize';
  return 'schedule_resolve';
}

function routeAfterValidate(
  state: GraphState,
): 'schedule_build_confirm' | 'schedule_present' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) return 'schedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'schedule_build_confirm';
  if (draft.phase === 'awaiting_pick') return 'schedule_present';
  // Fallback (collecting / unexpected): vuelve a finalize (defensa)
  return 'schedule_finalize';
}

function routeAfterPresent(
  state: GraphState,
): 'schedule_build_confirm' | 'schedule_resolve' | 'schedule_present' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) return 'schedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'schedule_build_confirm';
  if (draft.phase === 'collecting') return 'schedule_resolve';
  if (draft.phase === 'awaiting_pick') return 'schedule_present';
  return 'schedule_finalize';
}

function routeAfterGate(
  state: GraphState,
): 'schedule_commit' | 'schedule_resolve' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) return 'schedule_finalize';
  if (draft.phase === 'committing') return 'schedule_commit';
  if (draft.phase === 'collecting') return 'schedule_resolve';
  return 'schedule_finalize';
}

function routeAfterCommit(
  state: GraphState,
): 'schedule_success' | 'schedule_validate' | 'schedule_finalize' {
  const draft = readDraft(state);
  if (!isActiveDraft(draft)) {
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

/**
 * Pre-siembra el slot `appointmentUuid` de un subgrafo (confirm/cancel/reschedule)
 * cuando el turno entra por un tap sobre un botón de recordatorio (button shortcut
 * en frío). El uuid lo resolvió `supervisorEntryNode` cruzando el `contextMessageId`
 * del tap contra `template_send_log` (vía `recentTemplates`); el `bootstrap` del
 * subgrafo lo valida contra los upcomings y resuelve el `displayName`. Sin esto, el
 * subgrafo volvería a preguntar "¿cuál turno?" pese a que el usuario ya lo eligió.
 */
function preseedAppointmentSlot(
  slots: { appointmentUuid: SlotState<string> },
  shortcut: ButtonShortcut | undefined,
  kind: ButtonShortcut['kind'],
): void {
  if (shortcut?.kind !== kind || typeof shortcut.value !== 'string') return;
  slots.appointmentUuid = {
    value: shortcut.value,
    userPhrase: 'botón recordatorio',
    status: 'resolved',
  };
}

const readConfirmDraft = makeReadDraft<ConfirmDraftState>('confirm');

function routeAfterConfirmBootstrap(
  state: GraphState,
): 'confirm_ask_slot' | 'confirm_commit' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!isActiveDraft(draft)) return 'confirm_finalize';
  if (draft.phase === 'committing') return 'confirm_commit';
  if (draft.phase === 'collecting') return 'confirm_ask_slot';
  return 'confirm_finalize';
}

function routeAfterConfirmAskSlot(
  state: GraphState,
): 'confirm_ask_slot' | 'confirm_commit' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!isActiveDraft(draft)) return 'confirm_finalize';
  if (draft.phase === 'committing') return 'confirm_commit';
  // collecting: slot todavía empty/guessed → loop a ask_slot
  return 'confirm_ask_slot';
}

function routeAfterConfirmCommit(state: GraphState): 'confirm_success' | 'confirm_finalize' {
  const draft = readConfirmDraft(state);
  if (!isActiveDraft(draft)) return 'confirm_finalize';
  if (draft.phase === 'done') return 'confirm_success';
  return 'confirm_finalize';
}

// ============================================================================
// Cancel subgraph dispatch + routers
// ============================================================================

const readCancelDraft = makeReadDraft<CancelDraftState>('cancel');

function routeAfterCancelBootstrap(
  state: GraphState,
): 'cancel_ask_slot' | 'cancel_build_confirm' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!isActiveDraft(draft)) return 'cancel_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'cancel_build_confirm';
  if (draft.phase === 'collecting') return 'cancel_ask_slot';
  return 'cancel_finalize';
}

function routeAfterCancelAskSlot(
  state: GraphState,
): 'cancel_ask_slot' | 'cancel_build_confirm' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!isActiveDraft(draft)) return 'cancel_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'cancel_build_confirm';
  return 'cancel_ask_slot';
}

function routeAfterCancelGate(
  state: GraphState,
): 'cancel_commit' | 'cancel_ask_slot' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!isActiveDraft(draft)) return 'cancel_finalize';
  if (draft.phase === 'committing') return 'cancel_commit';
  if (draft.phase === 'collecting') return 'cancel_ask_slot';
  return 'cancel_finalize';
}

function routeAfterCancelCommit(state: GraphState): 'cancel_success' | 'cancel_finalize' {
  const draft = readCancelDraft(state);
  if (!isActiveDraft(draft)) return 'cancel_finalize';
  if (draft.phase === 'done') return 'cancel_success';
  return 'cancel_finalize';
}

// ============================================================================
// Reschedule subgraph dispatch + routers (H6)
// ============================================================================

const readRescheduleDraft = makeReadDraft<RescheduleDraftState>('reschedule');

function routeAfterRescheduleBootstrap(
  state: GraphState,
): 'reschedule_ask_slot' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
  return decideAfterCollecting(draft);
}

function routeAfterRescheduleAskSlot(
  state: GraphState,
): 'reschedule_ask_slot' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
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
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
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
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
  if (draft.phase === 'awaiting_confirmation') return 'reschedule_build_confirm';
  if (draft.phase === 'collecting') return 'reschedule_validate';
  if (draft.phase === 'awaiting_pick') return 'reschedule_present';
  return 'reschedule_finalize';
}

function routeAfterRescheduleGate(
  state: GraphState,
): 'reschedule_commit' | 'reschedule_ask_slot' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
  if (draft.phase === 'committing') return 'reschedule_commit';
  if (draft.phase === 'collecting') return 'reschedule_ask_slot';
  return 'reschedule_finalize';
}

function routeAfterRescheduleCommit(
  state: GraphState,
): 'reschedule_success' | 'reschedule_validate' | 'reschedule_finalize' {
  const draft = readRescheduleDraft(state);
  if (!isActiveDraft(draft)) return 'reschedule_finalize';
  if (draft.phase === 'validating_availability') return 'reschedule_validate';
  if (draft.phase === 'done') return 'reschedule_success';
  return 'reschedule_finalize';
}

// ============================================================================
// Query subgraph dispatch + routers (H7)
// ============================================================================

/**
 * Edge de salida del gate UNIFICADO: delega al router del gate del subgrafo
 * activo (por `__kind`). Reúne las salidas posibles de los 3 gates
 * (schedule/cancel/reschedule); cada uno conserva su propia lógica.
 */
function routeAfterSubgraphGate(
  state: GraphState,
):
  | 'schedule_commit'
  | 'schedule_resolve'
  | 'schedule_finalize'
  | 'cancel_commit'
  | 'cancel_ask_slot'
  | 'cancel_finalize'
  | 'reschedule_commit'
  | 'reschedule_ask_slot'
  | 'reschedule_finalize' {
  const kind = (state.subgraphState as { __kind?: ActiveSubgraph } | null)?.__kind;
  if (kind === 'cancel') return routeAfterCancelGate(state);
  if (kind === 'reschedule') return routeAfterRescheduleGate(state);
  return routeAfterGate(state);
}

const readQueryDraft = makeReadDraft<QueryDraftState>('query');

function routeAfterQueryClassify(
  state: GraphState,
): 'query_fetch' | 'query_synthesize' | 'query_finalize' {
  const draft = readQueryDraft(state);
  if (!isActiveDraft(draft)) return 'query_finalize';
  if (draft.phase === 'fetching') return 'query_fetch';
  if (draft.phase === 'synthesizing') return 'query_synthesize';
  return 'query_finalize';
}

function routeAfterQueryFetch(state: GraphState): 'query_synthesize' | 'query_finalize' {
  const draft = readQueryDraft(state);
  if (!isActiveDraft(draft)) return 'query_finalize';
  if (draft.phase === 'synthesizing') return 'query_synthesize';
  return 'query_finalize';
}
