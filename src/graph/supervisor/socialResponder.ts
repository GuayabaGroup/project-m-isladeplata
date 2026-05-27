import type { Logger } from 'winston';
import { SOCIAL_CONFIG } from '../../config/llm.config.js';
import type { Outcome } from '../../core/types/Outcome.js';
import type { AnthropicProvider } from '../../infrastructure/llm/AnthropicProvider.js';
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
  llm: AnthropicProvider;
  logger: Logger;
}

const PLATFORM_NAME_BY_ID: ReadonlyMap<number, string> = new Map([
  [1, 'Allia'],
  [2, 'Groomia'],
  [3, 'Divapp'],
]);

const FALLBACK_BY_TYPE: Record<MessageType, string> = {
  greeting: '¡Hola! ¿En qué te puedo ayudar?',
  farewell: '¡Hasta luego! Cualquier cosa estoy por acá.',
  oos: 'Puedo ayudarte con turnos, consultas y reservas. ¿Querés agendar algo?',
  action: 'No te entendí bien. ¿Podrías reformular?',
  query: 'Decime qué información necesitás.',
};

export function makeSocialResponderNode(deps: SocialDeps) {
  const { llm, logger } = deps;

  return async function socialResponder(state: GraphState): Promise<GraphStateUpdate> {
    const messageType: MessageType = state.routing?.messageType ?? 'oos';
    const text = sanitizeUserInput(state.input?.channelMessage?.contentText);
    const businessName = state.identity?.tenantName ?? 'el negocio';
    const platformName = state.identity?.platformId
      ? (PLATFORM_NAME_BY_ID.get(state.identity.platformId) ?? 'la plataforma')
      : 'la plataforma';

    const system = buildSystemPrompt(messageType, businessName, platformName);
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

function buildSystemPrompt(
  messageType: MessageType,
  businessName: string,
  platformName: string,
): string {
  const intro = `Sos un agente de atención al cliente para ${businessName} (${platformName}). Respondé en máximo 2 oraciones, tono amable, conciso, sin emojis.`;

  switch (messageType) {
    case 'greeting':
      return `${intro} El usuario te saluda — devolvé un saludo cálido y ofrecé ayudar con turnos o consultas.`;
    case 'farewell':
      return `${intro} El usuario se despide — saludalo y dejá la puerta abierta para volver.`;
    case 'oos':
      return `${intro} El usuario habla de algo fuera de tu scope (turnos, consultas, reservas). Redirigílo gentilmente sin ser cortante. NO digas "no puedo ayudarte" sin ofrecer alternativa.`;
    default:
      return `${intro} No quedó claro qué pide el usuario. Pedile que reformule, ofreciendo ayudar con turnos o consultas.`;
  }
}
