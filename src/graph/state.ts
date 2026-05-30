import type { BaseMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';
import type { TakeoverReasonCode } from '../core/enums/TakeoverReason.js';
import { type CatalogState, EMPTY_CATALOG } from '../core/types/Catalog.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import { type CrmContext, EMPTY_CRM_CONTEXT } from '../core/types/CrmContext.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { RecentTemplate } from '../core/types/RecentTemplate.js';
import { subgraphReducerDispatch } from './subgraphs/subgraphReducer.js';
import type { ButtonShortcut } from './supervisor/buttonShortcut.js';
import type { ToolName } from './supervisor/filterTools.js';

/**
 * Current turn's input. Set once by the pre-graph adapter before
 * `graph.invoke`. **Inmutable durante el turno** (§8.2 REGLAS_ISLADEPLATA).
 */
export interface GraphInput {
  channelMessage: ChannelMessage;
  receivedAt: string;
}

export type MessageType =
  | 'greeting'
  | 'farewell'
  | 'oos'
  | 'action'
  | 'query'
  /** El cliente pide explícitamente un humano (capa A, spec P-human-takeover).
   * Solo lo emite el clasificador cuando `HUMAN_TAKEOVER_ENABLED`. */
  | 'human_request';
export type Intent =
  | 'schedule'
  | 'reschedule'
  | 'cancel'
  | 'confirm'
  /** El usuario quiere AVISAR algo al negocio (llego tarde, estoy en la puerta,
   * una consulta) — no es agendar/cancelar/confirmar/reagendar. Rutea a la tool
   * atómica `forward_message`, no a un subgrafo. */
  | 'forward_message'
  | 'unknown';

export interface RoutingState {
  /** Which subgraph is currently active (set by supervisor on the way in). */
  activeSubgraph?: string;
  /** Reason the supervisor abdicated the active subgraph mid-flow. */
  handoff?: string;
  /** Resultado del classifier LLM o `null` si el atajo button bypaseó al classifier. */
  messageType?: MessageType;
  /** Sub-clasificación dentro de `messageType='action'`. */
  intent?: Intent;
  /** Confidence del classifier (0-1). */
  confidence?: number;
  /** Atajo determinístico — el supervisor lo detectó al inicio del turno. */
  buttonShortcut?: ButtonShortcut;
  /** Tool atómica detectada por heurística post-classifier. */
  targetTool?: ToolName;
  /** Razón de takeover humano que la capa que disparó (A clasificador / C juez)
   * deja para el nodo `request_human` (spec P-human-takeover). */
  takeoverReason?: TakeoverReasonCode;
}

export const MAX_RECENT_MESSAGES = 20;

/** Append + cap by N most recent. Custom reducer per spike recommendation. */
export function appendMessages(current: BaseMessage[], next: BaseMessage[]): BaseMessage[] {
  const combined = [...current, ...next];
  if (combined.length <= MAX_RECENT_MESSAGES) return combined;
  return combined.slice(-MAX_RECENT_MESSAGES);
}

/** Replace-only — used for input/identity (set once, then immutable). */
export function replaceWith<T>(_current: T, next: T): T {
  return next;
}

/** Shallow merge — used for routing where nodes set fields incrementally. */
export function mergeRouting(current: RoutingState, next: Partial<RoutingState>): RoutingState {
  return { ...current, ...next };
}

/**
 * Canonical state schema for the Isladeplata graph.
 *
 * Ownership table (§8.2 REGLAS_ISLADEPLATA):
 *
 * | Field         | Único mutador (intent)                              |
 * |---------------|-----------------------------------------------------|
 * | messages      | reducer estándar (append + cap)                     |
 * | input         | pre-graph adapter (inmutable durante el turno)      |
 * | identity      | pre-graph adapter (inmutable durante el turno)      |
 * | crmContext    | pre-graph adapter (carga única); nodos pueden refrescar opt-in |
 * | catalog       | pre-graph adapter (carga única desde identity.helpersLists)    |
 * | recentTemplates | pre-graph adapter (carga única; templates proactivos enviados) |
 * | routing       | supervisor                                          |
 * | subgraphState | el subgrafo activo                                  |
 * | outcome       | subgrafo activo al cerrar / supervisor en fast-paths |
 *
 * El reducer NO enforza ownership; eso es disciplina + code review.
 */
export const GraphStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
  input: Annotation<GraphInput | null>({
    reducer: replaceWith,
    default: () => null,
  }),
  identity: Annotation<Identity | null>({
    reducer: replaceWith,
    default: () => null,
  }),
  crmContext: Annotation<CrmContext>({
    reducer: replaceWith,
    default: () => EMPTY_CRM_CONTEXT,
  }),
  catalog: Annotation<CatalogState>({
    reducer: replaceWith,
    default: () => EMPTY_CATALOG,
  }),
  // Templates proactivos (recordatorios, confirmaciones) enviados a este usuario
  // recientemente. Carga única por turno (pre-grafo), replace-only. Da contexto
  // al supervisor para interpretar respuestas de texto libre al último template.
  recentTemplates: Annotation<RecentTemplate[]>({
    reducer: replaceWith,
    default: () => [],
  }),
  routing: Annotation<RoutingState>({
    reducer: mergeRouting,
    default: () => ({}),
  }),
  // Dispatch por `__kind` del state. Cada subgrafo (schedule, confirm, cancel,
  // reschedule, query) declara su propio reducer; el dispatcher rutea el merge.
  subgraphState: Annotation<unknown>({
    reducer: subgraphReducerDispatch,
    default: () => null,
  }),
  outcome: Annotation<Outcome | null>({
    reducer: replaceWith,
    default: () => null,
  }),
});

export type GraphState = typeof GraphStateAnnotation.State;
export type GraphStateUpdate = typeof GraphStateAnnotation.Update;
