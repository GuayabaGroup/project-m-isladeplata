/**
 * State del subgrafo `query` (text-to-data). Más simple que los subgrafos
 * write — sin slots, sin gate, sin commit. Lookup → synthesize → done.
 *
 * Scope v1 (decisión usuario): 4 intents fijos + cannot_answer. Sin
 * freeform SQL, sin business_hours (sin tool dedicado en Guacuco), sin
 * cache. Datos vienen del state ya cargado por pregraph (catalog, crmContext)
 * o de 1 call directo a Guacuco (`get_staff_appointments_summary`).
 */

import type { Outcome } from '../../../core/types/Outcome.js';
import type { SubgraphMeta } from '../common/state.js';

export type QueryIntent =
  | 'service_prices'
  | 'service_list'
  | 'my_upcoming'
  | 'staff_schedule_day'
  /** Free-form text-to-SQL: LLM genera SQL → validate local → Guacuco execute. */
  | 'freeform_sql'
  | 'cannot_answer';

export type QueryPhase = 'classifying' | 'fetching' | 'synthesizing' | 'done' | 'failed';

export interface QueryDraftState {
  __kind: 'query';
  /** Texto sanitizado del usuario (set por entry). */
  userText: string;
  /** Intent detectado por classify_query. */
  intent?: QueryIntent;
  /** Confidence del classifier (0-1). */
  confidence?: number;
  /** Result del lookup/Guacuco call. JSON-serializable para audit + LangSmith. */
  rawResult?: unknown;
  /** SQL generada por el LLM en freeform_sql (audit + Sentry trace). */
  generatedSql?: string;
  phase: QueryPhase;
  meta: SubgraphMeta;
  terminalOutcome?: Outcome;
}

export function initialQueryDraftState(userText: string): QueryDraftState {
  return {
    __kind: 'query',
    userText,
    phase: 'classifying',
    meta: { attempts: 0, recoverableErrors: [] },
  };
}
