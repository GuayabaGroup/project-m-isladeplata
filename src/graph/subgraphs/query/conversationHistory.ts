import type { BaseMessage } from '@langchain/core/messages';
import { sanitizeUserInput } from '../../../security/sanitize.js';

/**
 * Turno previo de la conversación inyectado a los prompts de generación SQL,
 * síntesis y judges. Permite resolver referencias anafóricas (pronombres,
 * determinantes como "¿y la próxima?", "el último", "dame detalles") contra el
 * contexto real del diálogo. Port del concepto `ConversationTurn` de IDP_OV1.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Cantidad de turnos previos que se inyectan a los prompts (igual a IDP_OV1). */
export const MAX_HISTORY_TURNS = 6;

/**
 * Construye el historial conversacional desde `state.messages` (poblado por el
 * `subgraphFinalize` compartido). Toma los últimos `MAX_HISTORY_TURNS`, mapea
 * `BaseMessage` → `ConversationTurn`, sanitiza el contenido de los mensajes del
 * usuario (los del asistente son texto generado por el propio pipeline, no
 * input externo) y descarta entradas vacías.
 *
 * Importante: `state.messages` durante un turno contiene SOLO turnos previos —
 * el par del turno actual se appendea recién en `finalize`. Por eso no hay que
 * descartar la pregunta actual acá.
 *
 * Retorna `undefined` si no hay historial (caller trata undefined como "sin
 * contexto previo").
 */
export function buildConversationHistory(
  messages: BaseMessage[] | undefined,
): ConversationTurn[] | undefined {
  if (!messages || messages.length === 0) return undefined;

  const recent = messages.slice(-MAX_HISTORY_TURNS);
  const turns: ConversationTurn[] = [];
  for (const msg of recent) {
    const role = messageRole(msg);
    if (!role) continue;
    const raw = typeof msg.content === 'string' ? msg.content : '';
    const content = role === 'user' ? sanitizeUserInput(raw) : raw.trim();
    if (content.length === 0) continue;
    turns.push({ role, content });
  }
  return turns.length > 0 ? turns : undefined;
}

function messageRole(msg: BaseMessage): 'user' | 'assistant' | null {
  const type = msg.getType();
  if (type === 'human') return 'user';
  if (type === 'ai') return 'assistant';
  return null;
}

/**
 * Heurística para decidir si corresponde un retry drill-down: si el historial
 * contiene al menos un turno del asistente con dato cuantitativo (un número o
 * una expresión de conteo tipo "tenés N", "hay N"), un rechazo del generador
 * por "ambigua" suele ser un falso negativo sobre un imperativo corto del
 * usuario ("dame detalles", "con quién"). El retry fuerza la interpretación
 * drill-down. Port de `QueryEngine.historyLooksLikeDrilldown` (IDP_OV1).
 */
export function historyLooksLikeDrilldown(history: ConversationTurn[] | undefined): boolean {
  if (!history || history.length === 0) return false;
  return history.some((t) => t.role === 'assistant' && /\d|ten[eé]s|tienes|hay\s/i.test(t.content));
}
