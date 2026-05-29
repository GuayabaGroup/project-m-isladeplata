import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import { buildPersona, toPersonaContext } from '../../../../config/personality/buildPersona.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import { type ConversationTurn, buildConversationHistory } from '../conversationHistory.js';
import type { QueryJudge } from '../queryJudge.js';
import { formatRowsAsDetails } from '../resultFormatter.js';
import type { QueryDraftState } from '../state.js';

/**
 * Sintetiza la respuesta final a partir del rawResult del fetch + el userText
 * original. LLM Haiku, máx 200 tokens — respuestas cortas estilo WhatsApp.
 *
 * Caso cannot_answer: usa prompt distinto (no hay data, solo respuesta amable).
 * Caso lista vacía (0 services, 0 upcomings, 0 turnos hoy): el prompt instruye
 * a degradar amablemente.
 *
 * Cap de tokens al rawResult JSON (~2000 chars) — decisión §7.3 plan H7.
 */

export interface SynthesizeResponseDeps {
  llm: LlmProvider;
  logger: Logger;
  /** QueryJudge para validar la síntesis de freeform_sql. Undefined → skip. */
  judge?: QueryJudge;
}

const RAW_RESULT_CHAR_CAP = 2000;

const SYNTH_TASK = `El usuario hizo una pregunta. Te paso los datos (en JSON) y la pregunta original.

Reglas:
- Respondé en máximo 3 oraciones, estilo WhatsApp.
- Si la lista es larga, mencioná los primeros 5 con "y X más".
- Si la data está vacía o no contiene info útil, degradá amablemente
  ("Aún no hay servicios cargados", "No tenés turnos próximos", etc.).
- NO inventes precios ni datos que no estén en el JSON.
- NO menciones UUIDs ni códigos internos.
- NO menciones la palabra "JSON" ni "data" en tu respuesta.`;

const CANNOT_ANSWER_TASK =
  'El usuario hizo una pregunta que no podés responder con los datos disponibles. PRIMERO: si el bloque <business_policies_and_notes> la responde (ej. medios de pago, cancelaciones, requisitos), contestá desde ahí — esa política es fuente autoritativa. Si no aplica, devolvé UN mensaje corto (máx 2 oraciones) explicando amablemente que no podés ayudar con eso pero que sí con precios, servicios o sus turnos próximos.';

// Nivel B (H9.2): el staff pregunta por la plataforma. El JSON trae
// { kind, content } con el markdown oficial. Anti-alucinación estricta.
const PLATFORM_INFO_TASK = `El usuario (staff del negocio) preguntó sobre la PLATAFORMA. Te paso el contenido oficial (markdown, en el campo "content") y la pregunta original.

Reglas:
- Respondé SOLO desde el contenido oficial provisto. Es la única fuente autoritativa.
- NO inventes pasos, menús, botones, precios, planes, features ni URLs que no estén en el contenido.
- Si el contenido NO cubre lo que se pregunta, decilo y sugerí contactar al equipo de soporte/comercial. No completes con suposiciones.
- Estilo WhatsApp, conciso. Usá viñetas para listas de pasos o planes.
- NO menciones la palabra "JSON", "markdown", "content" ni "data" en tu respuesta.`;

const CANNOT_ANSWER_FALLBACK =
  'No estoy seguro de poder responder eso. Si querés, podés preguntarme por precios, servicios o tus próximos turnos.';

export function makeSynthesizeResponseNode(deps: SynthesizeResponseDeps) {
  const { llm, logger, judge } = deps;

  return async function synthesizeResponse(state: {
    identity?: Identity;
    subgraphState?: unknown;
    messages?: BaseMessage[];
  }): Promise<Partial<QueryDraftState>> {
    const current = state.subgraphState as QueryDraftState | undefined;
    if (!current) return {};
    const history = buildConversationHistory(state.messages);

    const persona = state.identity
      ? buildPersona(toPersonaContext(state.identity), { aiIdentityDisclosure: true })
      : '';
    const isPlatformInfo =
      current.intent === 'platform_commercial' || current.intent === 'platform_onboarding';
    const task = isPlatformInfo ? PLATFORM_INFO_TASK : SYNTH_TASK;
    const synthSystem = persona ? `${persona}\n\n${task}` : task;

    // Branch 1: cannot_answer (classifier no encontró intent válido).
    if (current.intent === 'cannot_answer') {
      const response = await llm.complete({
        ...RESPONSE_CONFIG,
        maxTokens: 100,
        system: persona ? `${persona}\n\n${CANNOT_ANSWER_TASK}` : CANNOT_ANSWER_TASK,
        messages: [{ role: 'user', content: current.userText.slice(0, 500) }],
      });
      const text = response.text.length > 0 ? response.text : CANNOT_ANSWER_FALLBACK;
      logger.debug('query.synthesize cannot_answer', {
        length: text.length,
        fallback: response.text.length === 0,
      });
      return {
        phase: 'done',
        terminalOutcome: { action: 'response', pendingReply: { text } },
      };
    }

    // Branch 2: freeform_sql con error en pipeline → respuesta amable.
    if (current.intent === 'freeform_sql') {
      const freeformError = extractFreeformError(current.rawResult);
      if (freeformError) {
        logger.debug('query.synthesize freeform_error', { error: freeformError });
        const text = freeformErrorMessage(freeformError);
        return {
          phase: 'done',
          terminalOutcome: { action: 'response', pendingReply: { text } },
        };
      }
    }

    const rawJson = safeStringify(current.rawResult).slice(0, RAW_RESULT_CHAR_CAP);

    // Síntesis intento 1 (con historial para anáforas: "¿y la próxima?").
    const first = await synthOnce(llm, synthSystem, current.userText, rawJson, history);
    let text = first.length > 0 ? first : deterministicFallback(current);

    // Judge de síntesis — solo freeform_sql con rows reales + sql. Valida que la
    // respuesta NL refleje los rows sin inventar. Rechazo → 1 retry con critique;
    // doble rechazo (o LLM caído) → fallback determinístico formatRowsAsDetails
    // (proyecta columnas del row, fidelidad por construcción §9).
    const freeform = extractFreeformRows(current);
    if (judge && first.length > 0 && freeform) {
      const verdict = await judge.validateSynthesis({
        question: current.userText,
        sql: freeform.sql,
        synthesisText: first,
        rows: freeform.rows,
        rowCount: freeform.rowCount,
        history,
      });
      if (!verdict.approved) {
        logger.info('query.synthesize: judge rejected synthesis, retrying with critique', {
          reason: verdict.reason,
          critiquePreview: verdict.critique.slice(0, 160),
        });
        const retry = await synthOnce(llm, synthSystem, current.userText, rawJson, history, {
          previousSynthesis: first,
          critique: verdict.critique,
        });
        if (retry.length === 0) {
          text = formatRowsAsDetails(freeform.rows, freeform.rowCount);
        } else {
          const retryVerdict = await judge.validateSynthesis({
            question: current.userText,
            sql: freeform.sql,
            synthesisText: retry,
            rows: freeform.rows,
            rowCount: freeform.rowCount,
            history,
          });
          text = retryVerdict.approved
            ? retry
            : formatRowsAsDetails(freeform.rows, freeform.rowCount);
        }
      }
    }

    logger.debug('query.synthesize', {
      intent: current.intent,
      length: text.length,
      fallback: first.length === 0,
      hasGeneratedSql: !!current.generatedSql,
    });

    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text },
    };
    return { phase: 'done', terminalOutcome };
  };
}

/** Bloque de historial para el prompt de síntesis (resolución de anáforas). */
function historyBlock(history: ConversationTurn[] | undefined): string {
  if (!history || history.length === 0) return '';
  const lines = history
    .map((t) => `[${t.role === 'user' ? 'USUARIO' : 'ASISTENTE'}]: ${t.content}`)
    .join('\n');
  return `\n\nHistorial reciente (para interpretar preguntas de seguimiento):\n${lines}`;
}

/** Una llamada de síntesis. Retorna '' si el LLM falla (caller decide fallback).
 *  `system` ya viene compuesto con la persona + la tarea de síntesis. */
async function synthOnce(
  llm: LlmProvider,
  system: string,
  userText: string,
  rawJson: string,
  history: ConversationTurn[] | undefined,
  retry?: { previousSynthesis: string; critique: string },
): Promise<string> {
  const retryBlock = retry
    ? `\n\nTu respuesta anterior fue rechazada por un validador.\nRespuesta anterior: "${retry.previousSynthesis}"\nCrítica: ${retry.critique}\nCorregí la respuesta para que refleje SOLO los datos disponibles.`
    : '';
  const userPrompt = `Pregunta del usuario: "${userText.slice(0, 500)}"${historyBlock(history)}\n\nDatos disponibles:\n${rawJson}${retryBlock}\n\nRespondé al usuario.`;
  const response = await llm.complete({
    ...RESPONSE_CONFIG,
    maxTokens: 200,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.text;
}

/**
 * Extrae rows + rowCount + sql del rawResult de freeform_sql para el judge.
 * Retorna null si no es freeform, no hay sql, o no hay rows ejecutados (sin
 * rows no hay nada que validar — la síntesis va directo).
 */
function extractFreeformRows(
  state: QueryDraftState,
): { rows: Record<string, unknown>[]; rowCount: number; sql: string } | null {
  if (state.intent !== 'freeform_sql' || !state.generatedSql) return null;
  const result = state.rawResult as
    | { rows?: Record<string, unknown>[]; rowCount?: number }
    | undefined;
  if (!result?.rows || result.rows.length === 0 || typeof result.rowCount !== 'number') {
    return null;
  }
  return { rows: result.rows, rowCount: result.rowCount, sql: state.generatedSql };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return 'null';
  }
}

function deterministicFallback(state: QueryDraftState): string {
  switch (state.intent) {
    case 'service_prices':
    case 'service_list':
      return 'Tenemos varios servicios disponibles. Decime cuál te interesa y te paso los detalles.';
    case 'my_upcoming':
      return 'Acá puedo ayudarte con tus turnos. ¿Querés agendar uno?';
    case 'staff_schedule_day':
      return 'No pude generar el resumen del día. Probá de nuevo en un minuto.';
    case 'freeform_sql': {
      // Si tenemos rows ejecutados por Guacuco (validados, no inventados),
      // proyectamos el detalle determinístico (§9 anti-alucinación).
      const result = state.rawResult as
        | { rows?: Record<string, unknown>[]; rowCount?: number }
        | undefined;
      if (result?.rows && typeof result.rowCount === 'number') {
        return formatRowsAsDetails(result.rows, result.rowCount);
      }
      return CANNOT_ANSWER_FALLBACK;
    }
    default:
      return CANNOT_ANSWER_FALLBACK;
  }
}

type FreeformError =
  | 'cannot_answer'
  | 'empty_sql'
  | 'unsafe_sql'
  | 'execute_failed'
  | 'schema_unavailable'
  | 'role_unavailable';

function extractFreeformError(rawResult: unknown): FreeformError | null {
  if (!rawResult || typeof rawResult !== 'object') return null;
  const err = (rawResult as { error?: unknown }).error;
  if (typeof err !== 'string') return null;
  const known: ReadonlySet<FreeformError> = new Set<FreeformError>([
    'cannot_answer',
    'empty_sql',
    'unsafe_sql',
    'execute_failed',
    'schema_unavailable',
    'role_unavailable',
  ]);
  return known.has(err as FreeformError) ? (err as FreeformError) : null;
}

function freeformErrorMessage(error: FreeformError): string {
  switch (error) {
    case 'cannot_answer':
    case 'empty_sql':
      return 'No estoy seguro de cómo responder eso con los datos disponibles. ¿Podés reformular o probar con otra cosa?';
    case 'unsafe_sql':
      return 'No pude procesar tu consulta. Probá ser más específico.';
    case 'execute_failed':
      return 'La consulta no pudo ejecutarse correctamente. Probá de nuevo en un minuto.';
    case 'schema_unavailable':
      return 'No tengo acceso a los datos en este momento. Probá de nuevo en un minuto.';
    case 'role_unavailable':
      return 'No puedo determinar tu rol para acceder a los datos. Contactá al administrador.';
  }
}
