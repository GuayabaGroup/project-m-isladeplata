import type { OutcomeAction } from '../enums/OutcomeAction.js';
import type { TakeoverReasonCode } from '../enums/TakeoverReason.js';
import type { ToolCallRecord } from './ToolCall.js';

/**
 * Señal de disparo de takeover humano que el supervisor (capas A/C) adjunta al
 * `outcome` del turno. El pipeline la lee post-invoke y dispara el
 * `TakeoverNotifier` fire-and-forget. Se piggybackea en `outcome` (fresco por
 * turno) en lugar de un channel nuevo del state para evitar staleness entre
 * turnos. La capa B no usa esto — la detecta y dispara el propio pipeline.
 */
export interface TakeoverTrigger {
  reasonCode: TakeoverReasonCode;
}

export interface OutboundButton {
  id: string;
  title: string;
}

export interface OutboundListRow {
  id: string;
  title: string;
  description?: string;
}

export interface OutboundList {
  body: string;
  buttonLabel: string;
  rows: OutboundListRow[];
}

export interface OutboundCta {
  text: string;
  url: string;
  displayText: string;
}

export interface OutboundReply {
  text?: string;
  buttons?: OutboundButton[];
  list?: OutboundList;
  cta?: OutboundCta;
}

export interface Outcome {
  action: OutcomeAction;
  pendingReply?: OutboundReply;
  /**
   * Tools de Guacuco ejecutadas en el turno (set por `finalize` desde
   * `subgraphState.meta.toolCalls`). El pipeline las pasa al persister (P2).
   */
  toolCalls?: ToolCallRecord[];
  /**
   * Set por el supervisor (capas A/C) cuando se debe entregar la conversación a
   * un humano. El pipeline lo lee post-invoke y dispara el takeover
   * fire-and-forget (spec P-human-takeover).
   */
  takeover?: TakeoverTrigger;
}
