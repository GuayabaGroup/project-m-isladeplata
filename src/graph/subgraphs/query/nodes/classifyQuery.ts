import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import { parseLlmJson } from '../../../../core/parseLlmJson.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import { buildTemporalContext } from '../prompts/querySql.js';
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
  llm: LlmProvider;
  logger: Logger;
}

interface ClassifyOutput {
  intent: QueryIntent;
  confidence: number;
  /** Solo para staff_schedule_day: rango de fechas resuelto por el LLM (YYYY-MM-DD). */
  dateStart?: string;
  dateEnd?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_INTENTS: ReadonlySet<QueryIntent> = new Set<QueryIntent>([
  'service_prices',
  'service_list',
  'my_upcoming',
  'staff_schedule_day',
  'freeform_sql',
  'platform_commercial',
  'platform_onboarding',
  'cannot_answer',
]);

/** Intents staff-only (Nivel B). Un client que los pida se rebaja a cannot_answer. */
const STAFF_ONLY_INTENTS: ReadonlySet<QueryIntent> = new Set<QueryIntent>([
  'staff_schedule_day',
  'platform_commercial',
  'platform_onboarding',
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

/**
 * Prompt staff. Se construye por turno porque `staff_schedule_day` ahora
 * resuelve un rango de fechas relativo a HOY (mañana, esta semana, próximos N
 * días…), así que necesita la fecha actual + día de semana en la timezone del
 * staff. `temporal` viene de `buildTemporalContext` (mismo helper que freeform_sql).
 */
function buildStaffSystemPrompt(temporal: { currentDate: string; dayOfWeek: number }): string {
  const cd = temporal.currentDate;
  const dowNames = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const dowName = dowNames[temporal.dayOfWeek] ?? 'lunes';
  return `Sos un clasificador de preguntas para un agente de turnos. El usuario es STAFF del negocio.
Devolvé SOLO JSON: {"intent": string, "confidence": number, "date_start"?: string, "date_end"?: string}.

intent es uno de:
- "service_prices" — precios de servicios del negocio
- "service_list" — qué servicios ofrece el negocio
- "my_upcoming" — sus turnos propios donde el staff es CLIENTE (va a RECIBIR un servicio): "mi próximo turno", "tengo algún turno reservado para mí"
- "staff_schedule_day" — su agenda de TRABAJO: los turnos que el staff va a ATENDER, para cualquier día o rango. Cubre "hoy", "mañana", una fecha puntual, "esta semana", "la próxima semana", "los próximos N días", "este finde". Ejemplos: "qué tengo hoy", "mi agenda", "dame el resumen de mañana", "qué turnos tengo el viernes", "mi agenda de la semana", "resumen de los próximos 5 días".
- "freeform_sql" — pregunta sobre datos del negocio que NO cabe en los anteriores pero PODRÍA contestarse con SQL. Ejemplos: "cuánto facturé el mes pasado", "qué clientes vinieron 3 veces este año", "cuántos turnos cancelados hubo en marzo", "qué servicio se pidió más esta semana". Si la pregunta es ambigua o off-topic, NO uses freeform_sql — usá cannot_answer.
- "platform_commercial" — pregunta COMERCIAL sobre la PLATAFORMA en sí (el producto/chatbot, no el negocio del staff): su precio, planes, tarifas, qué incluye, descuentos, para quién es, cómo contratarla, con quién hablar para contratar, qué es. Ejemplos: "cuánto cuesta la plataforma", "qué planes hay", "qué incluye", "con quién hablo para contratar", "qué es esto". NO confundir con precios de los SERVICIOS del negocio (eso es service_prices).
- "platform_onboarding" — pregunta de SETUP/CÓMO-USAR la PLATAFORMA: configurar el negocio, subir servicios, cargar el equipo/staff, conectar WhatsApp, configurar horarios/disponibilidad, compartir la URL de reservas, cómo agendan los clientes, primeros pasos. Ejemplos: "cómo configuro mis horarios", "cómo subo mis servicios", "cómo le paso el link a mis clientes", "cómo conecto WhatsApp", "primeros pasos".
- "cannot_answer" — off-topic, demasiado vaga, o no es sobre datos del negocio ni sobre la plataforma.

INFORMACIÓN TEMPORAL (timezone del staff):
- Hoy es ${dowName}, ${cd} (YYYY-MM-DD).

REGLA DE FECHAS — SOLO cuando intent="staff_schedule_day":
Agregá "date_start" y "date_end" (ambos YYYY-MM-DD) resolviendo el día o rango pedido respecto a hoy:
- "hoy", "mi agenda", "qué tengo" (sin fecha) → date_start=date_end=${cd}
- "mañana" → ambos = ${cd} + 1 día
- una fecha o día puntual ("el viernes", "el 5") → ese día en date_start y date_end
- "esta semana" → desde hoy hasta el domingo de esta semana
- "la próxima semana" → lunes a domingo de la semana siguiente
- "los próximos N días" → date_start=${cd}, date_end=${cd} + (N-1) días
Si el rango supera 31 días, recortalo a 31. Para los demás intents, NO incluyas date_start/date_end.

confidence: número entre 0 y 1.
Respondé SOLO el JSON, sin prosa ni markdown.`;
}

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
    const systemPrompt =
      profileType === 'staff'
        ? buildStaffSystemPrompt(buildTemporalContext(state.identity?.timezone ?? 'UTC'))
        : SYSTEM_PROMPT_CLIENT;

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    const parsed = parseLlmJson<
      Partial<ClassifyOutput> & { date_start?: string; date_end?: string }
    >(response.text, logger, { component: 'query.classify' });
    const normalized = normalize(parsed, profileType);

    logger.debug('query.classify', { ...normalized, profileType, rawLen: response.text.length });

    // Si el intent requiere fetch (staff_schedule_day) → phase=fetching.
    // Para los lookup-only (service_prices, service_list, my_upcoming) →
    // phase=fetching también (el handler hace el lookup en state, no LLM).
    // cannot_answer salta directo a synthesize.
    const nextPhase: QueryDraftState['phase'] =
      normalized.intent === 'cannot_answer' ? 'synthesizing' : 'fetching';

    // Rango de fechas solo aplica a staff_schedule_day (validado en normalize).
    const scheduleRange =
      normalized.intent === 'staff_schedule_day' && normalized.dateStart && normalized.dateEnd
        ? { dateStart: normalized.dateStart, dateEnd: normalized.dateEnd }
        : undefined;

    return {
      intent: normalized.intent,
      confidence: normalized.confidence,
      phase: nextPhase,
      ...(scheduleRange ? { scheduleRange } : {}),
    };
  };
}

function normalize(
  raw: (Partial<ClassifyOutput> & { date_start?: string; date_end?: string }) | null,
  profileType: string,
): ClassifyOutput {
  if (!raw || typeof raw !== 'object') return { ...FAIL_OPEN };

  let intent: QueryIntent =
    typeof raw.intent === 'string' && VALID_INTENTS.has(raw.intent as QueryIntent)
      ? (raw.intent as QueryIntent)
      : FAIL_OPEN.intent;

  // Defensa-en-profundidad: si un client pide un intent staff-only
  // (staff_schedule_day, platform_commercial, platform_onboarding) → cannot_answer.
  // El prompt client no los menciona, pero el LLM podría emitirlos igual.
  if (STAFF_ONLY_INTENTS.has(intent) && profileType !== 'staff') {
    intent = 'cannot_answer';
  }

  const confidence =
    typeof raw.confidence === 'number' ? clamp01(raw.confidence) : FAIL_OPEN.confidence;

  const result: ClassifyOutput = { intent, confidence };

  // El rango de fechas solo se conserva para staff_schedule_day y solo si ambas
  // fechas vienen bien formadas (YYYY-MM-DD). Si faltan o son inválidas, fetch
  // cae a hoy/hoy — nunca se inventa una fecha desde acá.
  if (intent === 'staff_schedule_day') {
    const start = typeof raw.date_start === 'string' ? raw.date_start.trim() : '';
    const end = typeof raw.date_end === 'string' ? raw.date_end.trim() : '';
    if (DATE_RE.test(start) && DATE_RE.test(end)) {
      result.dateStart = start;
      result.dateEnd = end;
    }
  }

  return result;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return FAIL_OPEN.confidence;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
