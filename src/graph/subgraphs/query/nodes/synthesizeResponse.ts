import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
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
}

const RAW_RESULT_CHAR_CAP = 2000;

const SYSTEM_PROMPT = `Sos un agente de atención al cliente para un negocio de turnos.
El usuario hizo una pregunta. Te paso los datos (en JSON) y la pregunta original.

Reglas:
- Respondé en máximo 3 oraciones, tono amable, estilo WhatsApp.
- Si la lista es larga, mencioná los primeros 5 con "y X más".
- Si la data está vacía o no contiene info útil, degradá amablemente
  ("Aún no hay servicios cargados", "No tenés turnos próximos", etc.).
- NO inventes precios ni datos que no estén en el JSON.
- NO menciones UUIDs ni códigos internos.
- NO menciones la palabra "JSON" ni "data" en tu respuesta.`;

const CANNOT_ANSWER_FALLBACK =
  'No estoy seguro de poder responder eso. Si querés, podés preguntarme por precios, servicios o tus próximos turnos.';

export function makeSynthesizeResponseNode(deps: SynthesizeResponseDeps) {
  const { llm, logger } = deps;

  return async function synthesizeResponse(state: {
    subgraphState?: unknown;
  }): Promise<Partial<QueryDraftState>> {
    const current = state.subgraphState as QueryDraftState | undefined;
    if (!current) return {};

    // Branch 1: cannot_answer (classifier no encontró intent válido).
    if (current.intent === 'cannot_answer') {
      const response = await llm.complete({
        ...RESPONSE_CONFIG,
        maxTokens: 100,
        system:
          'Sos un agente de atención al cliente. El usuario hizo una pregunta que no podés responder con los datos disponibles. Devolvé UN mensaje corto (máx 2 oraciones) explicando amablemente que no podés ayudar con eso pero que podés con precios, servicios o sus turnos próximos.',
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
    const userPrompt = `Pregunta del usuario: "${current.userText.slice(0, 500)}"\n\nDatos disponibles:\n${rawJson}\n\nRespondé al usuario.`;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const fallback = deterministicFallback(current);
    const text = response.text.length > 0 ? response.text : fallback;

    logger.debug('query.synthesize', {
      intent: current.intent,
      length: text.length,
      fallback: response.text.length === 0,
      hasGeneratedSql: !!current.generatedSql,
    });

    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text },
    };
    return { phase: 'done', terminalOutcome };
  };
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
