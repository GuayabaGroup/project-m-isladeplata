import type { BaseMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import { type CrmContext, EMPTY_CRM_CONTEXT } from '../core/types/CrmContext.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';

/**
 * Current turn's input. Set once by the pre-graph adapter before
 * `graph.invoke`. **Inmutable durante el turno** (§8.2 REGLAS_ISLADEPLATA).
 */
export interface GraphInput {
  channelMessage: ChannelMessage;
  receivedAt: string;
}

export interface RoutingState {
  /** Which subgraph is currently active (set by supervisor on the way in). */
  activeSubgraph?: string;
  /** Reason the supervisor abdicated the active subgraph mid-flow. */
  handoff?: string;
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
  routing: Annotation<RoutingState>({
    reducer: mergeRouting,
    default: () => ({}),
  }),
  subgraphState: Annotation<unknown>({
    reducer: replaceWith,
    default: () => null,
  }),
  outcome: Annotation<Outcome | null>({
    reducer: replaceWith,
    default: () => null,
  }),
});

export type GraphState = typeof GraphStateAnnotation.State;
export type GraphStateUpdate = typeof GraphStateAnnotation.Update;
