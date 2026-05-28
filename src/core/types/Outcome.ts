import type { OutcomeAction } from '../enums/OutcomeAction.js';
import type { ToolCallRecord } from './ToolCall.js';

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
}
