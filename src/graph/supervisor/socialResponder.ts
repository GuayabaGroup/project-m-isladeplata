import type { Logger } from 'winston';
import { SOCIAL_CONFIG } from '../../config/llm.config.js';
import { buildPersona, toPersonaContext } from '../../config/personality/buildPersona.js';
import type { TakeoverReasonCode } from '../../core/enums/TakeoverReason.js';
import type { Outcome } from '../../core/types/Outcome.js';
import type { LlmProvider } from '../../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../../security/sanitize.js';
import type { GraphState, GraphStateUpdate, MessageType } from '../state.js';

/**
 * Fast-path social responder. Genera respuesta corta y amable para
 * greeting/farewell/oos/social_unknown. Single LLM call, sin tools, sin
 * historial (decisión §7.2 PLAN_H3B — solo turno actual).
 *
 * Si el LLM falla o devuelve texto vacío, fallback a una respuesta
 * determinística genérica para no quedar mudo.
 */

export interface SocialDeps {
  llm: LlmProvider;
  logger: Logger;
}

const FALLBACK_BY_TYPE: Record<MessageType, string> = {
  greeting: '¡Hola! ¿En qué te puedo ayudar?',
  farewell: '¡Hasta luego! Cualquier cosa estoy por acá.',
  oos: 'Puedo ayudarte con turnos, consultas y reservas. ¿Querés agendar algo?',
  action: 'No te entendí bien. ¿Podrías reformular?',
  query: 'Decime qué información necesitás.',
  // human_request se maneja en el short-circuit de arriba; entrada defensiva.
  human_request: 'Te conecto con una persona del equipo.',
};

/** Respuesta canned del handoff a humano (capas A/C). Determinística, sin LLM. */
const HUMAN_HANDOFF_REPLY =
  'Entiendo. Te conecto con una persona del equipo: en breve te van a responder por acá. 🙌';

export function makeSocialResponderNode(deps: SocialDeps) {
  const { llm, logger } = deps;

  return async function socialResponder(state: GraphState): Promise<GraphStateUpdate> {
    const messageType: MessageType = state.routing?.messageType ?? 'oos';

    // Takeover (capas A/C, spec P-human-takeover): handoff canned + señal de
    // takeover, SIN call LLM. El pipeline lee `outcome.takeover` y dispara el
    // notifier fire-and-forget; a partir del próximo turno el gate silencia.
    if (messageType === 'human_request') {
      const reasonCode: TakeoverReasonCode = state.routing?.takeoverReason ?? 'other';
      logger.info('Human takeover requested', { reason_code: reasonCode });
      const outcome: Outcome = {
        action: 'handed_off',
        pendingReply: { text: HUMAN_HANDOFF_REPLY },
        takeover: { reasonCode },
      };
      return { outcome };
    }

    const text = sanitizeUserInput(state.input?.channelMessage?.contentText);

    const persona = state.identity
      ? buildPersona(toPersonaContext(state.identity), { aiIdentityDisclosure: true })
      : '';
    const system = buildSystemPrompt(messageType, persona);
    const userTurn = text.length > 0 ? text : '[mensaje vacío]';

    const response = await llm.complete({
      ...SOCIAL_CONFIG,
      system,
      messages: [{ role: 'user', content: userTurn }],
    });

    const replyText = response.text.length > 0 ? response.text : FALLBACK_BY_TYPE[messageType];
    logger.debug('socialResponder', {
      messageType,
      replyLen: replyText.length,
      fallback: response.text.length === 0,
    });

    const outcome: Outcome = {
      action: 'response',
      pendingReply: { text: replyText },
    };
    return { outcome };
  };
}

/**
 * Instrucción de tarea por tipo de mensaje. La VOZ (persona de marca, nombre
 * del asistente, identidad del negocio, acento) la define el bloque de persona
 * que se antepone; aquí solo va el objetivo del turno + restricción de largo.
 */
const TASK_BY_TYPE: Record<MessageType, string> = {
  greeting:
    'El usuario te saluda — devolvé un saludo cálido y ofrecé ayudar con turnos o consultas. Máximo 2 oraciones.',
  farewell:
    'El usuario se despide — saludalo y dejá la puerta abierta para volver. Máximo 2 oraciones.',
  oos: 'El usuario habla de algo aparentemente fuera de tu scope (turnos, consultas, reservas). PRIMERO: si el bloque <business_policies_and_notes> responde lo que pregunta (ej. medios de pago, cancelaciones, requisitos), contestá desde ahí — esa política redefine tu scope, NO la trates como fuera de tema. Si no aplica, redirigílo gentilmente sin ser cortante, NUNCA digas "no puedo ayudarte" sin ofrecer alternativa. Máximo 2 oraciones.',
  action:
    'No quedó claro qué pide el usuario. Pedile que reformule, ofreciendo ayudar con turnos o consultas. Máximo 2 oraciones.',
  query:
    'No quedó claro qué información necesita el usuario. Pedile que reformule, ofreciendo ayudar con turnos o consultas. Máximo 2 oraciones.',
  human_request:
    'El usuario pide hablar con una persona. Avisale que lo derivás a alguien del equipo. Máximo 2 oraciones.',
};

function buildSystemPrompt(messageType: MessageType, persona: string): string {
  const task = TASK_BY_TYPE[messageType] ?? TASK_BY_TYPE.oos;
  const fallbackIntro =
    'Sos el asistente virtual de atención al cliente del negocio. Respondé amable y conciso, en español.';
  const preamble = persona.length > 0 ? persona : fallbackIntro;
  return `${preamble}\n\n${task}`;
}
