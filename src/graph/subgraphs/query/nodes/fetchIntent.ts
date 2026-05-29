import type { BaseMessage } from '@langchain/core/messages';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type {
  QueryProcessorExecuteResponse,
  QueryProcessorTablesResponse,
} from '../../../../clients/types/GuacucoTypes.js';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import { parseLlmJson } from '../../../../core/parseLlmJson.js';
import type { CatalogState } from '../../../../core/types/Catalog.js';
import type { CrmContext } from '../../../../core/types/CrmContext.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type {
  PlatformContentKind,
  PlatformContentLoader,
} from '../../../../infrastructure/content/PlatformContentLoader.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import {
  type ConversationTurn,
  buildConversationHistory,
  historyLooksLikeDrilldown,
} from '../conversationHistory.js';
import { buildSqlGenerationPrompt, buildTemporalContext } from '../prompts/querySql.js';
import type { QueryJudge } from '../queryJudge.js';
import { truncateResultsForSynthesis } from '../resultTruncator.js';
import { resolveAllowedSchema } from '../schemaResolver.js';
import { validateSql } from '../sqlValidator.js';
import type { QueryDraftState } from '../state.js';

/**
 * Resuelve el rawResult según el intent clasificado.
 * - Lookup-only intents (service_prices, service_list, my_upcoming): state local.
 * - staff_schedule_day: 1 call a Guacuco (get_staff_appointments_summary).
 * - freeform_sql: load schema (cached) → LLM generate SQL → validate local
 *   → Guacuco execute → 1 retry on execute error → truncate.
 * - cannot_answer: defensivo (classifier ya seteó phase=synthesizing).
 *
 * Output siempre JSON-serializable para audit + LangSmith.
 */

export interface FetchIntentDeps {
  guacuco: GuacucoClient;
  llm: LlmProvider;
  logger: Logger;
  /** QueryJudge para freeform_sql. Undefined → judge deshabilitado (skip). */
  judge?: QueryJudge;
  /**
   * Loader de contenido de plataforma (Nivel B, H9.2) para los intents
   * `platform_commercial`/`platform_onboarding`. Undefined → se trata como
   * "sin contenido" y se escala a soporte (defensivo; bootstrap siempre lo inyecta).
   */
  platformContent?: PlatformContentLoader;
}

const FORBIDDEN_OUTCOME: Outcome = {
  action: 'response',
  pendingReply: {
    text: 'No tengo acceso a esa información con tu perfil. ¿Querés que te ayude con otra cosa?',
  },
};

const FETCH_ERROR_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'No pude consultar esa información en este momento. Probá de nuevo en un minuto.',
  },
};

/**
 * Escalación determinista de Nivel B (H9.2): un staff preguntó algo
 * comercial/onboarding pero NO hay markdown cargado para su plataforma. En vez
 * de dejar que el LLM invente pasos/precios/URLs, derivamos a un humano.
 *
 * `action: 'handed_off'` + `takeover` adjunto: si `HUMAN_TAKEOVER_ENABLED=true`,
 * el pipeline dispara el `TakeoverNotifier` (escalación real, IDP-style). Si
 * está apagado, el bloque de takeover del pipeline se saltea pero el usuario
 * igual recibe el `pendingReply` canned — robusto a ambos estados (ver
 * docs/PLAN_H9_BUSINESS_CONTENT.md §2).
 */
function platformEscalationOutcome(kind: PlatformContentKind): Outcome {
  const topic = kind === 'commercial' ? 'comercial' : 'de configuración';
  return {
    action: 'handed_off',
    pendingReply: {
      text: `Para tu consulta ${topic} sobre la plataforma te derivo con el equipo de soporte: en breve te contactan por acá. 🙌`,
    },
    takeover: { reasonCode: 'other' },
  };
}

// freeform SQL usa el supervisor model (Haiku) por simplicidad. Plan original
// sugería Sonnet — si la calidad de SQL es baja en producción, promover a
// Sonnet via env nueva (out of scope iter 1).
const SQL_GEN_TEMPERATURE = 0.1;
const SQL_GEN_MAX_TOKENS = 1024;

const MAX_SQL_ROWS = 25;
const SCHEMA_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedSchema {
  schemaText: string;
  fetchedAt: number;
}

interface SqlGenerationResult {
  answerable: boolean;
  sql?: string;
  reason?: string;
}

export function makeFetchIntentNode(deps: FetchIntentDeps) {
  const { guacuco, llm, logger, judge, platformContent } = deps;
  // Schema cache per (profileType:roleId) — singleton del closure del factory.
  const schemaCache = new Map<string, CachedSchema>();

  return async function fetchIntent(state: {
    identity?: Identity | null;
    catalog?: CatalogState;
    crmContext?: CrmContext;
    messages?: BaseMessage[];
    subgraphState?: unknown;
  }): Promise<Partial<QueryDraftState>> {
    const current = state.subgraphState as QueryDraftState | undefined;
    if (!current?.intent) return {};

    const intent = current.intent;
    const catalog = state.catalog ?? { services: [] };
    const crmContext = state.crmContext ?? { upcomingAppointments: [], profileMeta: {} };
    const identity = state.identity;

    switch (intent) {
      case 'service_prices':
      case 'service_list': {
        const services = catalog.services.map((s) => ({
          name: s.name,
          description: s.description,
          price: s.price,
        }));
        return { rawResult: { services }, phase: 'synthesizing' };
      }

      case 'my_upcoming': {
        const upcomings = crmContext.upcomingAppointments.map((a) => ({
          description: a.description,
          ...(a.startAt ? { startAt: a.startAt } : {}),
        }));
        return { rawResult: { upcomings }, phase: 'synthesizing' };
      }

      case 'staff_schedule_day': {
        if (identity?.profileType !== 'staff') {
          logger.warn('query.fetch: staff_schedule_day requested by non-staff', {
            profileType: identity?.profileType,
          });
          return { phase: 'failed', terminalOutcome: FORBIDDEN_OUTCOME };
        }
        if (!identity.tenantUuid) {
          logger.warn('query.fetch: missing identity.tenantUuid for staff_schedule_day');
          return { phase: 'failed', terminalOutcome: FETCH_ERROR_OUTCOME };
        }
        const today = todayInTimezone(identity.timezone ?? 'UTC');
        try {
          const result = await guacuco.getStaffAppointmentsSummary(
            { date_start: today, date_end: today },
            identity,
          );
          return { rawResult: { summary: result, date: today }, phase: 'synthesizing' };
        } catch (err) {
          logger.warn('query.fetch: getStaffAppointmentsSummary failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          return { phase: 'failed', terminalOutcome: FETCH_ERROR_OUTCOME };
        }
      }

      case 'freeform_sql': {
        return runFreeformSql({
          state: current,
          identity,
          guacuco,
          llm,
          logger,
          schemaCache,
          judge,
          history: buildConversationHistory(state.messages),
        });
      }

      case 'platform_commercial':
      case 'platform_onboarding': {
        const kind: PlatformContentKind =
          intent === 'platform_commercial' ? 'commercial' : 'onboarding';

        // Staff-only (defensa en profundidad; classify ya rebaja a client).
        if (identity?.profileType !== 'staff') {
          logger.warn('query.fetch: platform content requested by non-staff', {
            kind,
            profileType: identity?.profileType,
          });
          return { phase: 'failed', terminalOutcome: FORBIDDEN_OUTCOME };
        }

        const content = platformContent?.get(kind, identity.platformId)?.trim();
        if (!content || content.length === 0) {
          // Sin contenido → escalación determinista (no inventar).
          logger.info('query.fetch: no platform content, escalating', {
            kind,
            platformId: identity.platformId,
          });
          return { phase: 'failed', terminalOutcome: platformEscalationOutcome(kind) };
        }

        return { rawResult: { kind, content }, phase: 'synthesizing' };
      }

      case 'cannot_answer':
        return { phase: 'synthesizing' };
    }
  };
}

// ============================================================================
// freeform_sql pipeline
// ============================================================================

interface FreeformDeps {
  state: QueryDraftState;
  identity: Identity | null | undefined;
  guacuco: GuacucoClient;
  llm: LlmProvider;
  logger: Logger;
  schemaCache: Map<string, CachedSchema>;
  judge?: QueryJudge;
  history?: ConversationTurn[];
}

// Instrucción forzada para el retry drill-down (cuando el generador rechazó como
// no answerable pero el historial revela un follow-up sobre datos previos).
const DRILLDOWN_RETRY_CONTEXT = [
  'DRILL-DOWN RETRY: el turno anterior del asistente respondió con datos',
  'cuantitativos. La PREGUNTA ACTUAL es un drill-down sobre esos mismos registros.',
  'NO respondas answerable:false. Heredá WHERE y rango temporal del último turno',
  'del USUARIO en el historial y proyectá columnas descriptivas adicionales',
  '(staff_name, service_name, fecha, hora, status) sobre el mismo WHERE.',
].join(' ');

async function runFreeformSql(deps: FreeformDeps): Promise<Partial<QueryDraftState>> {
  const { state, identity, guacuco, llm, logger, schemaCache, judge, history } = deps;

  if (!identity) {
    return { phase: 'failed', terminalOutcome: FETCH_ERROR_OUTCOME };
  }

  // 1. Resolver schema permitido por rol.
  const schemaResolution = resolveAllowedSchema(identity.profileType, identity.roleId);
  if (!schemaResolution.ok) {
    logger.warn('query.freeform: schema resolution failed', { reason: schemaResolution.reason });
    return {
      rawResult: { error: 'role_unavailable', reason: schemaResolution.reason },
      phase: 'synthesizing',
    };
  }
  const allowedSchema = schemaResolution.allowedSchema;

  // 2. Cargar schema text (cached 1h por rol).
  const schemaText = await loadSchemaText(
    identity.profileType,
    identity.roleId,
    guacuco,
    schemaCache,
    logger,
  );
  if (!schemaText) {
    logger.warn('query.freeform: schema fetch failed');
    return {
      rawResult: { error: 'schema_unavailable' },
      phase: 'synthesizing',
    };
  }

  // 3. Generar SQL con LLM (con historial para anáforas).
  const temporal = buildTemporalContext(identity.timezone ?? 'UTC');
  let genResult = await generateSql({
    question: state.userText,
    schemaText,
    identity,
    allowedSchema,
    temporal,
    llm,
    logger,
    history,
  });

  // 3b. Drill-down retry: si rechazó como no answerable pero el historial
  // contiene una respuesta cuantitativa previa, el usuario está haciendo
  // drill-down ("dame detalles", "con quién"). Un único retry forzando la
  // interpretación recupera estos casos sin ciclar (port IDP_OV1).
  if (!genResult.answerable && historyLooksLikeDrilldown(history)) {
    logger.info('query.freeform: drilldown_retry', {
      originalReason: genResult.reason?.slice(0, 120),
    });
    const retry = await generateSql({
      question: state.userText,
      schemaText,
      identity,
      allowedSchema,
      temporal,
      llm,
      logger,
      history,
      errorContext: DRILLDOWN_RETRY_CONTEXT,
    });
    if (retry.answerable && retry.sql) genResult = retry;
    else if (retry.reason) genResult = retry;
  }

  if (!genResult.answerable) {
    return {
      rawResult: { error: 'cannot_answer', reason: genResult.reason },
      phase: 'synthesizing',
    };
  }
  if (!genResult.sql) {
    return {
      rawResult: { error: 'empty_sql' },
      phase: 'synthesizing',
    };
  }

  // 4. Validar SQL local (5 capas).
  let sql = genResult.sql;
  const validation = validateSql(sql, allowedSchema);
  if (!validation.valid) {
    logger.warn('query.freeform: local SQL validation failed', {
      error: validation.error,
      sqlPreview: sql.slice(0, 200),
    });
    return {
      rawResult: { error: 'unsafe_sql', reason: validation.error },
      generatedSql: sql,
      phase: 'synthesizing',
    };
  }

  // 5. Ejecutar SQL. 1 retry on execute error con contexto del error.
  let result: QueryProcessorExecuteResponse;
  try {
    result = await guacuco.executeQuery(sql, identity.profileType, identity.roleId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn('query.freeform: executeQuery failed, retrying with error context', {
      error: errorMessage,
      sqlPreview: sql.slice(0, 200),
    });

    const retryContext = [
      'The previous SQL query failed:',
      '```sql',
      sql,
      '```',
      `Error: ${errorMessage}`,
      '',
      'Generate a corrected SQL query that fixes this error.',
    ].join('\n');

    genResult = await generateSql({
      question: state.userText,
      schemaText,
      identity,
      allowedSchema,
      temporal,
      llm,
      logger,
      errorContext: retryContext,
      history,
    });

    if (!genResult.answerable || !genResult.sql) {
      return {
        rawResult: { error: 'execute_failed', reason: errorMessage },
        generatedSql: sql,
        phase: 'synthesizing',
      };
    }

    sql = genResult.sql;
    const retryValidation = validateSql(sql, allowedSchema);
    if (!retryValidation.valid) {
      logger.warn('query.freeform: retry SQL also failed local validation', {
        error: retryValidation.error,
      });
      return {
        rawResult: { error: 'unsafe_sql', reason: retryValidation.error },
        generatedSql: sql,
        phase: 'synthesizing',
      };
    }

    try {
      result = await guacuco.executeQuery(sql, identity.profileType, identity.roleId);
    } catch (retryErr) {
      const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logger.warn('query.freeform: retry executeQuery also failed', { error: retryError });
      return {
        rawResult: { error: 'execute_failed', reason: retryError },
        generatedSql: sql,
        phase: 'synthesizing',
      };
    }
  }

  // 6. Judge SQL post-ejecución (si habilitado). Valida correctitud semántica,
  // filtro de perfil obligatorio, coherencia de resultados y alineación con el
  // schema. Si rechaza, regenera UNA vez con el critique como feedback y
  // re-ejecuta; no re-juzga (evita ciclos). Ante fallo del retry, conserva el
  // resultado original (rows reales validados por las 5 capas + server-side).
  if (judge) {
    const verdict = await judge.validateSql({
      question: state.userText,
      sql,
      schemaText,
      profileType: identity.profileType,
      profileUuid: identity.profileUuid,
      rows: result.rows,
      rowCount: result.rowCount,
      history,
    });
    if (!verdict.approved) {
      logger.info('query.freeform: judge rejected SQL, retrying with critique', {
        reason: verdict.reason,
        critiquePreview: verdict.critique.slice(0, 160),
      });
      const retried = await regenerateAndExecuteWithCritique({
        state,
        identity,
        guacuco,
        llm,
        logger,
        schemaText,
        allowedSchema,
        temporal,
        previousSql: sql,
        critique: verdict.critique,
        history,
      });
      if (retried) {
        sql = retried.sql;
        result = retried.result;
      }
    }
  }

  // 7. Truncar resultados antes de sintetizar.
  const truncation = truncateResultsForSynthesis(result.rows);
  if (truncation.wasTruncated) {
    logger.info('query.freeform: results truncated', {
      original: truncation.originalCount,
      truncated: truncation.rows.length,
    });
  }

  return {
    rawResult: {
      rows: truncation.rows,
      rowCount: result.rowCount,
      wasTruncated: truncation.wasTruncated,
    },
    generatedSql: sql,
    phase: 'synthesizing',
  };
}

/**
 * Regenera SQL con el critique del judge como feedback, valida localmente y
 * ejecuta. Retorna `{sql, result}` si todo el ciclo pasa, o `null` si cualquier
 * paso falla (el caller conserva entonces el resultado original). No re-juzga.
 */
async function regenerateAndExecuteWithCritique(args: {
  state: QueryDraftState;
  identity: Identity;
  guacuco: GuacucoClient;
  llm: LlmProvider;
  logger: Logger;
  schemaText: string;
  allowedSchema: string;
  temporal: ReturnType<typeof buildTemporalContext>;
  previousSql: string;
  critique: string;
  history?: ConversationTurn[];
}): Promise<{ sql: string; result: QueryProcessorExecuteResponse } | null> {
  const { state, identity, guacuco, llm, logger, schemaText, allowedSchema, temporal } = args;
  const critiqueContext = [
    'El judge rechazó la query previa:',
    '```sql',
    args.previousSql,
    '```',
    `Crítica: ${args.critique}`,
    '',
    'Generá una SQL corregida que resuelva la crítica.',
  ].join('\n');

  const gen = await generateSql({
    question: state.userText,
    schemaText,
    identity,
    allowedSchema,
    temporal,
    llm,
    logger,
    errorContext: critiqueContext,
    history: args.history,
  });
  if (!gen.answerable || !gen.sql) return null;

  const validation = validateSql(gen.sql, allowedSchema);
  if (!validation.valid) {
    logger.warn('query.freeform: judge-retry SQL failed local validation', {
      error: validation.error,
    });
    return null;
  }

  try {
    const result = await guacuco.executeQuery(gen.sql, identity.profileType, identity.roleId);
    return { sql: gen.sql, result };
  } catch (err) {
    logger.warn('query.freeform: judge-retry executeQuery failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function generateSql(args: {
  question: string;
  schemaText: string;
  identity: Identity;
  allowedSchema: string;
  temporal: ReturnType<typeof buildTemporalContext>;
  llm: LlmProvider;
  logger: Logger;
  errorContext?: string;
  history?: ConversationTurn[];
}): Promise<SqlGenerationResult> {
  const {
    question,
    schemaText,
    identity,
    allowedSchema,
    temporal,
    llm,
    logger,
    errorContext,
    history,
  } = args;
  const prompt = buildSqlGenerationPrompt(
    question,
    schemaText,
    identity,
    allowedSchema,
    MAX_SQL_ROWS,
    temporal,
    errorContext,
    history,
  );

  try {
    const response = await llm.complete({
      model: SUPERVISOR_CONFIG.model,
      temperature: SQL_GEN_TEMPERATURE,
      maxTokens: SQL_GEN_MAX_TOKENS,
      system: prompt.systemPrompt,
      messages: [{ role: 'user', content: prompt.userMessage }],
    });

    const parsed = parseLlmJson<{
      answerable?: boolean;
      sql?: string;
      sql_query?: string;
      reason?: string;
    }>(response.text, logger, { component: 'query.generateSql' });

    if (!parsed) {
      return { answerable: false, reason: 'No se pudo parsear la respuesta del generador SQL.' };
    }
    const sql = parsed.sql ?? parsed.sql_query;
    const answerable = parsed.answerable === true || (!!sql && sql.trim().length > 0);
    return { answerable, sql, reason: parsed.reason };
  } catch (err) {
    logger.warn('query.generateSql: LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { answerable: false, reason: 'Error técnico al generar la consulta.' };
  }
}

async function loadSchemaText(
  profileType: 'client' | 'staff',
  roleId: number | undefined,
  guacuco: GuacucoClient,
  cache: Map<string, CachedSchema>,
  logger: Logger,
): Promise<string | null> {
  const cacheKey = `${profileType}:${roleId ?? 'none'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) {
    return cached.schemaText;
  }

  try {
    const tables: QueryProcessorTablesResponse = await guacuco.getQueryTables(profileType, roleId);
    const lines: string[] = [];
    for (const table of tables) {
      const rawName = table.table_name;
      const shortName = rawName.includes('.') ? (rawName.split('.')[1] ?? rawName) : rawName;
      try {
        const schema = await guacuco.getQueryTableSchema(shortName, profileType, roleId);
        const cols = schema.columns.map((c) => {
          let desc = `  ${c.column_name} ${c.data_type}`;
          if (c.is_nullable === 'NO') desc += ' NOT NULL';
          if (c.column_comment) desc += ` -- ${c.column_comment}`;
          return desc;
        });
        const fks = schema.foreignKeys.map(
          (fk) => `  FK: ${fk.column_name} → ${fk.foreign_table_name}.${fk.foreign_column_name}`,
        );
        const tableDesc = table.table_comment ? ` -- ${table.table_comment}` : '';
        const parts = [`TABLE ${rawName}${tableDesc}:`, ...cols];
        if (fks.length > 0) parts.push(...fks);
        lines.push(parts.join('\n'));
      } catch (err) {
        logger.warn('query.loadSchema: skipping table', {
          tableName: rawName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (lines.length === 0) return null;
    const text = lines.join('\n\n');
    cache.set(cacheKey, { schemaText: text, fetchedAt: Date.now() });
    return text;
  } catch (err) {
    logger.warn('query.loadSchema: getQueryTables failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function todayInTimezone(timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
