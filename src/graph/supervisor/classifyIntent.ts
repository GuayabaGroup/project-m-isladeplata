import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../config/llm.config.js';
import { parseLlmJson } from '../../core/parseLlmJson.js';
import type { LlmProvider } from '../../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../../security/sanitize.js';
import { renderRecentTemplatesContext } from '../nodes/renderRecentTemplates.js';
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
  /** Capa A (spec P-human-takeover): si `true`, el clasificador reconoce el
   * messageType `human_request`. Default `false` → comportamiento idéntico al
   * de antes del takeover. */
  humanRequestEnabled?: boolean;
  /** Capa C (spec P-human-takeover): juez de frustración opt-in. Si está
   * presente, corre ANTES del clasificador y, si dispara, cortocircuita a
   * `human_request`. Se omite cuando `TAKEOVER_SENTIMENT_ENABLED=false`. */
  frustrationJudge?: (sanitizedText: string) => Promise<boolean>;
}

interface ClassifyOutput {
  messageType: MessageType;
  confidence: number;
  intent?: Intent;
}

const BASE_MESSAGE_TYPES: readonly MessageType[] = [
  'greeting',
  'farewell',
  'oos',
  'action',
  'query',
];

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

const BASE_SYSTEM_PROMPT = `Sos un clasificador de intent para un agente de turnos.
Devolvé SOLO JSON con el shape {"messageType": string, "confidence": number, "intent"?: string}.

messageType es uno de:
- "greeting"  — saludos: hola, buenas, gracias, cómo estás
- "farewell"  — despedidas: chau, adiós, hasta luego, nos vemos
- "oos"       — fuera de scope: clima, política, fútbol, chistes
- "action"    — el usuario quiere HACER algo (agendar, cancelar, reagendar, confirmar)
- "query"     — pregunta informativa (precio, horario, servicios, próximos turnos)`;

// Rama de la capa A: solo se inyecta cuando HUMAN_TAKEOVER_ENABLED.
const HUMAN_REQUEST_PROMPT_LINE = `- "human_request" — el usuario pide explícitamente hablar con una PERSONA/humano/agente real, o rechaza al bot ("quiero hablar con alguien", "pasame con una persona", "no quiero un bot", "atención humana")`;

const PROMPT_TAIL = `Si messageType="action", incluí intent con uno de:
- "schedule", "reschedule", "cancel", "confirm", "unknown"

confidence: número entre 0 y 1.

Respondé SOLO el JSON, sin prosa ni markdown.`;

// Nivel B (H9.2): cuando el usuario es STAFF, las preguntas sobre la PLATAFORMA
// (producto/precio) y sobre cómo CONFIGURARLA/usarla son consultas informativas
// → "query" (no "oos" ni "action"). Sin esto, "¿cómo configuro mis horarios?"
// caería en oos/action y nunca llegaría al subgrafo query (donde viven los
// intents platform_commercial/platform_onboarding). Solo se anexa para staff.
const STAFF_QUERY_HINT = `
El usuario es STAFF del negocio. Clasificá también como "query":
- preguntas sobre la PLATAFORMA/producto en sí: qué es, precio, planes, qué incluye, cómo contratarla
- preguntas de cómo CONFIGURAR o USAR la plataforma: subir servicios, cargar al equipo, conectar WhatsApp, configurar horarios/disponibilidad, compartir el link de reservas, primeros pasos
Estas NO son "oos" ni "action": son informativas → "query".`;

function buildSystemPrompt(humanRequestEnabled: boolean, staff: boolean): string {
  const typeLines = humanRequestEnabled
    ? `${BASE_SYSTEM_PROMPT}\n${HUMAN_REQUEST_PROMPT_LINE}`
    : BASE_SYSTEM_PROMPT;
  const staffHint = staff ? `\n${STAFF_QUERY_HINT}` : '';
  return `${typeLines}${staffHint}\n\n${PROMPT_TAIL}`;
}

export function makeClassifyIntentNode(deps: ClassifyDeps) {
  const { llm, logger, humanRequestEnabled = false, frustrationJudge } = deps;
  // Dos variantes precomputadas; se elige por rol en cada turno (Nivel B H9.2).
  const clientSystemPrompt = buildSystemPrompt(humanRequestEnabled, false);
  const staffSystemPrompt = buildSystemPrompt(humanRequestEnabled, true);
  const validTypes = new Set<MessageType>(
    humanRequestEnabled ? [...BASE_MESSAGE_TYPES, 'human_request'] : BASE_MESSAGE_TYPES,
  );

  return async function classifyIntent(state: GraphState): Promise<GraphStateUpdate> {
    const text = sanitizeUserInput(state.input?.channelMessage?.contentText);
    if (text.length === 0) {
      logger.debug('classifyIntent skipped: empty input');
      return { routing: { ...FAIL_OPEN } };
    }

    // Capa C: el juez de frustración corre primero y cortocircuita a
    // `human_request` (sin gastar la call de clasificación) si dispara.
    if (frustrationJudge && (await frustrationJudge(text))) {
      return {
        routing: {
          messageType: 'human_request',
          confidence: 1,
          takeoverReason: 'sentiment_frustration',
        },
      };
    }

    const baseSystemPrompt =
      state.identity?.profileType === 'staff' ? staffSystemPrompt : clientSystemPrompt;
    // Contexto del último template enviado (recordatorio, confirmación…): permite
    // clasificar respuestas de texto libre que de otro modo llegarían sin
    // contexto (ej. "sí" tras un recordatorio → action:confirm). Vacío → no anexa.
    const templateContext = renderRecentTemplatesContext(state.recentTemplates ?? []);
    const systemPrompt = templateContext
      ? `${baseSystemPrompt}\n\n${templateContext}`
      : baseSystemPrompt;
    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    const parsed = parseLlmJson<Partial<ClassifyOutput>>(response.text, logger, {
      component: 'classifyIntent',
    });

    const normalized = normalizeOutput(parsed, validTypes);
    logger.debug('classifyIntent', { ...normalized, rawLen: response.text.length });

    // Capa A: marca la razón para que `request_human` arme el disparo.
    if (normalized.messageType === 'human_request') {
      return { routing: { ...normalized, takeoverReason: 'explicit_request' } };
    }
    return { routing: { ...normalized } };
  };
}

function normalizeOutput(
  raw: Partial<ClassifyOutput> | null,
  validTypes: ReadonlySet<MessageType>,
): ClassifyOutput {
  if (!raw || typeof raw !== 'object') return { ...FAIL_OPEN };

  const messageType =
    typeof raw.messageType === 'string' && validTypes.has(raw.messageType as MessageType)
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
