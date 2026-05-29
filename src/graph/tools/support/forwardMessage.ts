import { RESPONSE_CONFIG } from '../../../config/llm.config.js';
import type { Outcome } from '../../../core/types/Outcome.js';
import { buildUserMessageChain } from '../../../infrastructure/llm/buildUserMessageChain.js';
import { sanitizeUserInput } from '../../../security/sanitize.js';
import type { GraphState, GraphStateUpdate } from '../../state.js';
import type { AtomicTool, ToolDeps } from '../Tool.js';

const ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude reenviar tu mensaje al negocio. Probá de nuevo en un minuto.',
  },
};

const EMPTY_OUTCOME: Outcome = {
  action: 'ignored',
};

/**
 * Instrucción para resumir el mensaje del cliente + contexto antes de
 * reenviarlo al negocio. El LLM solo produce TEXTO (no datos críticos, §9.2):
 * no inventa nombres/horarios/montos que no estén en la conversación.
 */
const SUMMARY_SYSTEM_PROMPT = `Sos un asistente que resume, para el dueño de un negocio, lo que un cliente quiere comunicarle.
Resumí en 1-2 oraciones, en tercera persona y en español, SOLO lo que el cliente expresó en la conversación.
Reglas:
- No inventes datos (nombres, horarios, montos) que no aparezcan en la conversación.
- No agregues saludos, despedidas ni relleno.
- Enfocate en el último mensaje; usá los anteriores solo como contexto.
- Si el mensaje ya es claro y breve, devolvelo prácticamente igual.`;

/**
 * Genera un resumen del último mensaje + contexto reciente para reenviar al
 * negocio. Fail-open (§11.3): si el LLM devuelve vacío (incluye `stopReason:
 * 'error'`, que `complete` nunca lanza), cae al texto crudo — el negocio igual
 * recibe algo útil.
 */
async function summarizeForForward(
  state: GraphState,
  cleanText: string,
  deps: ToolDeps,
): Promise<string> {
  const messages = buildUserMessageChain(state.messages ?? [], cleanText);
  const response = await deps.llm.complete({
    ...RESPONSE_CONFIG,
    system: SUMMARY_SYSTEM_PROMPT,
    messages,
  });

  const summary = response.text.trim();
  if (summary.length === 0) {
    deps.logger.warn('forwardMessage: summary empty, falling back to raw message');
    return cleanText;
  }
  return summary;
}

/**
 * Reenvía el mensaje del usuario al negocio (ej: "estoy en la puerta",
 * "llego tarde"). En H3.B SIN gate de confirmación interactiva — decisión §7
 * PLAN_H3B: simple, agregar gate en H5 cuando el patrón esté validado en H4.
 */
export const forwardMessage: AtomicTool = {
  name: 'forward_message',
  allowedRoles: ['client', 'staff'],

  async run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate> {
    const identity = state.identity;
    const rawText = state.input?.channelMessage?.contentText ?? '';
    const cleanText = sanitizeUserInput(rawText);

    if (!identity?.tenantAlliaId || !identity?.profileUuid) {
      deps.logger.warn('forwardMessage: missing identity fields');
      return { outcome: ERROR_OUTCOME };
    }
    if (cleanText.length === 0) {
      deps.logger.debug('forwardMessage: empty message, nothing to forward');
      return { outcome: EMPTY_OUTCOME };
    }

    try {
      const summary = await summarizeForForward(state, cleanText, deps);
      await deps.guacuco.forwardMessage(summary, identity);

      const outcome: Outcome = {
        action: 'response',
        pendingReply: {
          text: 'Listo, tu mensaje fue enviado al negocio. Te van a contactar a la brevedad.',
        },
      };
      return { outcome };
    } catch (err) {
      deps.logger.warn('forwardMessage failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: ERROR_OUTCOME };
    }
  },
};
