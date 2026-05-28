import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import { parseLlmJson } from '../../../../core/parseLlmJson.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { AnthropicProvider } from '../../../../infrastructure/llm/AnthropicProvider.js';
import type { QueryDraftState, QueryIntent } from '../state.js';

/**
 * Clasificador de intent para queries informativas. LLM Haiku output JSON.
 * Determina cuál de los 4 intents fijos aplica, o cannot_answer.
 *
 * Fail-open: si parseo falla → cannot_answer (respuesta amable, sin riesgo).
 *
 * Role-aware: si role=client, NUNCA devuelve staff_schedule_day (lo rebaja a
 * cannot_answer). Defensa-en-profundidad — el handler también lo chequea.
 */

export interface ClassifyQueryDeps {
  llm: AnthropicProvider;
  logger: Logger;
}

interface ClassifyOutput {
  intent: QueryIntent;
  confidence: number;
}

const VALID_INTENTS: ReadonlySet<QueryIntent> = new Set<QueryIntent>([
  'service_prices',
  'service_list',
  'my_upcoming',
  'staff_schedule_day',
  'freeform_sql',
  'cannot_answer',
]);

const FAIL_OPEN: ClassifyOutput = { intent: 'cannot_answer', confidence: 0.3 };

const SYSTEM_PROMPT_CLIENT = `Sos un clasificador de preguntas para un agente de turnos. El usuario es un CLIENTE.
Devolvé SOLO JSON: {"intent": string, "confidence": number}.

intent es uno de:
- "service_prices" — pregunta por precio ("cuánto cuesta corte", "precios")
- "service_list" — pregunta qué servicios hay ("qué ofrecen", "qué servicios tienen")
- "my_upcoming" — pregunta por sus turnos próximos ("tengo turnos", "cuándo es mi próximo")
- "freeform_sql" — pregunta informativa sobre datos del negocio que NO cabe en los anteriores pero PODRÍA contestarse con datos. Ejemplos: "cuánto gasté este año", "cuántas veces fui en marzo", "cuál fue mi último servicio". Si la pregunta es ambigua o off-topic, NO uses freeform_sql — usá cannot_answer.
- "cannot_answer" — preguntas off-topic (clima, política), demasiado vagas, o sobre temas que no son datos del negocio.

confidence: número entre 0 y 1.
NO incluyas "staff_schedule_day" (es solo para staff).
Respondé SOLO el JSON, sin prosa ni markdown.`;

const SYSTEM_PROMPT_STAFF = `Sos un clasificador de preguntas para un agente de turnos. El usuario es STAFF del negocio.
Devolvé SOLO JSON: {"intent": string, "confidence": number}.

intent es uno de:
- "service_prices" — precios de servicios del negocio
- "service_list" — qué servicios ofrece el negocio
- "my_upcoming" — sus turnos propios próximos (como cliente)
- "staff_schedule_day" — agenda de trabajo del staff de HOY ("qué tengo hoy", "agenda")
- "freeform_sql" — pregunta sobre datos del negocio que NO cabe en los anteriores pero PODRÍA contestarse con SQL. Ejemplos: "cuánto facturé el mes pasado", "qué clientes vinieron 3 veces este año", "cuántos turnos cancelados hubo en marzo", "qué servicio se pidió más esta semana". Si la pregunta es ambigua o off-topic, NO uses freeform_sql — usá cannot_answer.
- "cannot_answer" — off-topic, demasiado vaga, o no es sobre datos del negocio.

confidence: número entre 0 y 1.
Respondé SOLO el JSON, sin prosa ni markdown.`;

export function makeClassifyQueryNode(deps: ClassifyQueryDeps) {
  const { llm, logger } = deps;

  return async function classifyQuery(state: {
    identity?: Identity | null;
    subgraphState?: unknown;
  }): Promise<Partial<QueryDraftState>> {
    const current = state.subgraphState as QueryDraftState | undefined;
    if (!current) return {};

    const text = current.userText.trim();
    if (text.length === 0) {
      logger.debug('query.classify: empty userText → cannot_answer');
      return { intent: 'cannot_answer', confidence: 0, phase: 'synthesizing' };
    }

    const profileType = state.identity?.profileType ?? 'client';
    const systemPrompt = profileType === 'staff' ? SYSTEM_PROMPT_STAFF : SYSTEM_PROMPT_CLIENT;

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    const parsed = parseLlmJson<Partial<ClassifyOutput>>(response.text, logger, {
      component: 'query.classify',
    });
    const normalized = normalize(parsed, profileType);

    logger.debug('query.classify', { ...normalized, profileType, rawLen: response.text.length });

    // Si el intent requiere fetch (staff_schedule_day) → phase=fetching.
    // Para los lookup-only (service_prices, service_list, my_upcoming) →
    // phase=fetching también (el handler hace el lookup en state, no LLM).
    // cannot_answer salta directo a synthesize.
    const nextPhase: QueryDraftState['phase'] =
      normalized.intent === 'cannot_answer' ? 'synthesizing' : 'fetching';

    return { intent: normalized.intent, confidence: normalized.confidence, phase: nextPhase };
  };
}

function normalize(raw: Partial<ClassifyOutput> | null, profileType: string): ClassifyOutput {
  if (!raw || typeof raw !== 'object') return { ...FAIL_OPEN };

  let intent: QueryIntent =
    typeof raw.intent === 'string' && VALID_INTENTS.has(raw.intent as QueryIntent)
      ? (raw.intent as QueryIntent)
      : FAIL_OPEN.intent;

  // Defensa-en-profundidad: si client pide staff_schedule_day → cannot_answer.
  if (intent === 'staff_schedule_day' && profileType !== 'staff') {
    intent = 'cannot_answer';
  }

  const confidence =
    typeof raw.confidence === 'number' ? clamp01(raw.confidence) : FAIL_OPEN.confidence;

  return { intent, confidence };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return FAIL_OPEN.confidence;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
