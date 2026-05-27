import type { OutcomeAction } from '../enums/OutcomeAction.js';

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
}
