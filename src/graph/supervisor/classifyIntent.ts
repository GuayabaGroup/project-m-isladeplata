import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../config/llm.config.js';
import { parseLlmJson } from '../../core/parseLlmJson.js';
import type { LlmProvider } from '../../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../../security/sanitize.js';
import type { GraphState, GraphStateUpdate, Intent, MessageType } from '../state.js';

/**
 * Clasificador de intent. LLM Haiku con output JSON estructurado. Sanitiza
 * input antes de pasar al modelo (§13). Fail-open al default seguro
 * `{messageType: 'action', intent: 'unknown', confidence: 0.3}` para que el
 * router lo trate como "no entendí, contestá amable" en vez de romper.
 */

export interface ClassifyDeps {
  llm: LlmProvider;
  logger: Logger;
}

interface ClassifyOutput {
  messageType: MessageType;
  confidence: number;
  intent?: Intent;
}

const VALID_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  'greeting',
  'farewell',
  'oos',
  'action',
  'query',
]);

const VALID_INTENTS: ReadonlySet<Intent> = new Set<Intent>([
  'schedule',
  'reschedule',
  'cancel',
  'confirm',
  'unknown',
]);

const FAIL_OPEN: ClassifyOutput = {
  messageType: 'action',
  intent: 'unknown',
  confidence: 0.3,
};

const SYSTEM_PROMPT = `Sos un clasificador de intent para un agente de turnos.
Devolvé SOLO JSON con el shape {"messageType": string, "confidence": number, "intent"?: string}.

messageType es uno de:
- "greeting"  — saludos: hola, buenas, gracias, cómo estás
- "farewell"  — despedidas: chau, adiós, hasta luego, nos vemos
- "oos"       — fuera de scope: clima, política, fútbol, chistes
- "action"    — el usuario quiere HACER algo (agendar, cancelar, reagendar, confirmar)
- "query"     — pregunta informativa (precio, horario, servicios, próximos turnos)

Si messageType="action", incluí intent con uno de:
- "schedule", "reschedule", "cancel", "confirm", "unknown"

confidence: número entre 0 y 1.

Respondé SOLO el JSON, sin prosa ni markdown.`;

export function makeClassifyIntentNode(deps: ClassifyDeps) {
  const { llm, logger } = deps;

  return async function classifyIntent(state: GraphState): Promise<GraphStateUpdate> {
    const text = sanitizeUserInput(state.input?.channelMessage?.contentText);
    if (text.length === 0) {
      logger.debug('classifyIntent skipped: empty input');
      return { routing: { ...FAIL_OPEN } };
    }

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const parsed = parseLlmJson<Partial<ClassifyOutput>>(response.text, logger, {
      component: 'classifyIntent',
    });

    const normalized = normalizeOutput(parsed);
    logger.debug('classifyIntent', { ...normalized, rawLen: response.text.length });

    return { routing: { ...normalized } };
  };
}

function normalizeOutput(raw: Partial<ClassifyOutput> | null): ClassifyOutput {
  if (!raw || typeof raw !== 'object') return { ...FAIL_OPEN };

  const messageType =
    typeof raw.messageType === 'string' && VALID_MESSAGE_TYPES.has(raw.messageType as MessageType)
      ? (raw.messageType as MessageType)
      : FAIL_OPEN.messageType;

  const confidenceRaw = typeof raw.confidence === 'number' ? raw.confidence : FAIL_OPEN.confidence;
  const confidence = clamp01(confidenceRaw);

  const result: ClassifyOutput = { messageType, confidence };

  if (messageType === 'action') {
    const intent =
      typeof raw.intent === 'string' && VALID_INTENTS.has(raw.intent as Intent)
        ? (raw.intent as Intent)
        : 'unknown';
    result.intent = intent;
  }

  return result;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return FAIL_OPEN.confidence;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
