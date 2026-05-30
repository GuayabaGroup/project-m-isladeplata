import type { GraphState, Intent } from '../state.js';
import { type ToolName, getAvailableTools } from './filterTools.js';

/**
 * Intents que el classifier emite y que mapean a una tool ATÓMICA (no a un
 * subgrafo). El router las rutea a `tool_<name>` directamente, gateadas por rol.
 * El resto de los intents de acción (schedule/confirm/cancel/reschedule) van al
 * placeholder de subgrafo. Todos estos valores son también `ToolName`.
 */
const ATOMIC_TOOL_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'forward_message',
  'retrieve_manzanillo_url',
  'connect_mercado_pago',
]);

/**
 * Router del supervisor. Conditional edge function: dado el state (ya con
 * `routing` populado por buttonShortcut+classifier+heurística), decide a qué
 * nodo ir.
 *
 * Salidas posibles (node names que `compile.ts` registra):
 * - 'subgraph_placeholder' — marcador intermedio para intents de subgrafo
 *   (schedule/confirm/cancel/reschedule/query) y atajos button. `compile.ts`
 *   lo resuelve al `*_dispatch` real vía `routeFromSupervisorWithSubgraphs`;
 *   solo cae al nodo placeholder un button stale sin subgrafo activo.
 * - 'social_responder'     — greeting/farewell/oos/social_unknown.
 * - `tool_<name>`          — tools atómicas (retrieve_manzanillo, etc).
 *
 * Reglas:
 * - Atajo button tiene prioridad absoluta.
 * - Tools/subgrafos no permitidos por el rol caen a social_responder con
 *   `messageType='oos'` reescrito previamente (acá NO mutamos state — el
 *   responder usa el `messageType` ya seteado por classifier; si la heurística
 *   detecta una tool no permitida la silenciamos para que el responder maneje).
 * - Confianza baja en 'action'/'query' (<0.5) → social_responder.
 */

export type RouterDestination = 'social_responder' | 'subgraph_placeholder' | `tool_${ToolName}`;

export const SUBGRAPH_PLACEHOLDER_NODE = 'subgraph_placeholder' as const;
export const SOCIAL_RESPONDER_NODE = 'social_responder' as const;

const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function routeFromSupervisor(state: GraphState): RouterDestination {
  const routing = state.routing ?? {};
  const identity = state.identity;
  const profileType = identity?.profileType ?? 'client';
  const allowed = getAvailableTools(profileType, identity?.roleId, identity?.platformId);

  // 1. Atajo button — prioridad absoluta.
  if (routing.buttonShortcut) {
    return SUBGRAPH_PLACEHOLDER_NODE;
  }

  const messageType = routing.messageType ?? 'oos';

  // 1.5. Takeover capas A/C — el cliente pidió explícitamente un humano o el
  // juez detectó frustración. Va al `social_responder`, que reconoce el
  // messageType `human_request` y emite el handoff canned + la señal de takeover
  // (sin call LLM). Solo se emite cuando HUMAN_TAKEOVER_ENABLED.
  if (messageType === 'human_request') {
    return SOCIAL_RESPONDER_NODE;
  }

  // 2. Social fast-path.
  if (messageType === 'greeting' || messageType === 'farewell' || messageType === 'oos') {
    return SOCIAL_RESPONDER_NODE;
  }

  // 3. Subgrafos: devuelve el marcador; `routeFromSupervisorWithSubgraphs`
  // (compile.ts) lo traduce al `*_dispatch` real según intent.
  if (messageType === 'action') {
    const intent = routing.intent ?? 'unknown';

    // 3a. Intents que mapean a una tool ATÓMICA (forward_message,
    // retrieve_manzanillo_url, connect_mercado_pago): el classifier los emite
    // como intent. Se chequean ANTES del ramo de subgrafos porque también están
    // en el set de tools permitidas y, sin esto, caerían al placeholder de
    // subgrafo. Gateados por rol vía `allowed`.
    if (ATOMIC_TOOL_INTENTS.has(intent) && allowed.has(intent as ToolName)) {
      return `tool_${intent as ToolName}` satisfies RouterDestination;
    }

    if (intent !== 'unknown' && allowed.has(intent as ToolName)) {
      return SUBGRAPH_PLACEHOLDER_NODE;
    }

    // 3b. Tool atómica detectada por heurística.
    if (routing.targetTool && allowed.has(routing.targetTool)) {
      return `tool_${routing.targetTool}` satisfies RouterDestination;
    }

    // 4. Action con intent='unknown' o tool no permitida → social fallback.
    return SOCIAL_RESPONDER_NODE;
  }

  // 5. Query: marcador → `query_dispatch` (resuelto en compile.ts).
  if (messageType === 'query' && allowed.has('query')) {
    return SUBGRAPH_PLACEHOLDER_NODE;
  }

  // 6. Confianza baja o cualquier fallback.
  if ((routing.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) {
    return SOCIAL_RESPONDER_NODE;
  }
  return SOCIAL_RESPONDER_NODE;
}

/**
 * Heurística de keywords para detectar tool atómica (decisión §7 PLAN_H3B —
 * empezamos simple, evaluamos después de piloto).
 *
 * Solo se invoca cuando `messageType='action'` y `intent='unknown'`. Si matchea
 * y la tool está permitida para el rol, el router se va a `tool_<name>`.
 */
const TOOL_PATTERNS: ReadonlyArray<{ pattern: RegExp; tool: ToolName }> = [
  { pattern: /\b(link|reserva|reservar|booking)\b/i, tool: 'retrieve_manzanillo_url' },
  { pattern: /mercado.?pago|cobros|cobrar/i, tool: 'connect_mercado_pago' },
  {
    // Avisos de llegada tarde en cualquier conjugación/relleno ("llego tarde",
    // "llegaré tarde", "llegare un poco tarde", "voy a llegar 10 min tarde") +
    // las frases de presencia física. Los typos extremos ("lelgare") los cubre
    // el classifier vía intent='forward_message'; esto es solo el fast-path.
    pattern:
      /\blleg[\wáéíóúñ]*(?:\s+\S+){0,3}\s+tarde\b|\bestoy afuera\b|\bestacionamiento\b|\bestoy en la puerta\b/i,
    tool: 'forward_message',
  },
];

export function detectAtomicTool(text: string): ToolName | null {
  for (const { pattern, tool } of TOOL_PATTERNS) {
    if (pattern.test(text)) return tool;
  }
  return null;
}
