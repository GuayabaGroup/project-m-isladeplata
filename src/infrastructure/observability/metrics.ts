import { Counter, Histogram, Registry } from 'prom-client';

/**
 * Registry de métricas Prometheus para isladeplata.
 *
 * Reglas:
 * - Singleton del módulo. Los counters/histograms se crean una sola vez al
 *   import del módulo y se mantienen vivos durante el proceso.
 * - Bajos límites de cardinalidad: labels acotados a enums conocidos
 *   (`channel`, `profile_type`, `outcome_action`). NO incluir tenant/business
 *   en labels — la dimensión "por negocio" se observa via Sentry/LangSmith.
 * - `resetMetrics()` limpia counters entre tests. NO usar en producción.
 *
 * Buckets del histograma de latencia: pensados para un pipeline cuyo p95
 * objetivo es ~3s (turn end-to-end con grafo + LLM). Granularidad fina hasta
 * 1s, más gruesa para outliers.
 */
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 3500, 5000, 10000, 20000];

export const metricsRegistry = new Registry();

export const turnProcessedTotal = new Counter({
  name: 'isladeplata_turn_processed_total',
  help: 'Total de turnos procesados por el pipeline (incluye duplicados detectados — ver outcome_action).',
  labelNames: ['channel', 'outcome_action'],
  registers: [metricsRegistry],
});

export const rateLimitHitTotal = new Counter({
  name: 'isladeplata_rate_limit_hit_total',
  help: 'Total de turnos rechazados por rate limit antes de invocar el grafo.',
  labelNames: ['channel'],
  registers: [metricsRegistry],
});

export const identityNotFoundTotal = new Counter({
  name: 'isladeplata_identity_not_found_total',
  help: 'Total de turnos terminados en silent skip por IdentityNotFoundError.',
  labelNames: ['channel'],
  registers: [metricsRegistry],
});

export const subgraphEnteredTotal = new Counter({
  name: 'isladeplata_subgraph_entered_total',
  help: 'Subgrafos activados por turno (extraído de routing.activeSubgraph).',
  labelNames: ['subgraph'],
  registers: [metricsRegistry],
});

export const persistTurnTotal = new Counter({
  name: 'isladeplata_persist_turn_total',
  help: 'Intentos de persistencia P2 (POST /api/v1/conversations/agent-turns).',
  labelNames: ['result'],
  registers: [metricsRegistry],
});

export const takeoverTotal = new Counter({
  name: 'isladeplata_takeover_total',
  help: 'Disparos de takeover humano por capa (reason_code) y resultado del POST a Guacuco.',
  labelNames: ['reason_code', 'result'],
  registers: [metricsRegistry],
});

export const takeoverMutedTotal = new Counter({
  name: 'isladeplata_takeover_muted_total',
  help: 'Turnos silenciados por el gate de takeover (conversación en human_controlled).',
  labelNames: ['channel'],
  registers: [metricsRegistry],
});

export const roleProfileMismatchTotal = new Counter({
  name: 'isladeplata_role_profile_mismatch_total',
  help: 'Turnos descartados (fail-closed) porque el rol de la línea entrante no coincide con el profileType resuelto.',
  labelNames: ['channel'],
  registers: [metricsRegistry],
});

export const pipelineLatencyMs = new Histogram({
  name: 'isladeplata_pipeline_latency_ms',
  help: 'Latencia end-to-end del pipeline en milisegundos.',
  labelNames: ['outcome_action'],
  buckets: LATENCY_BUCKETS_MS,
  registers: [metricsRegistry],
});

/**
 * Resetea TODOS los counters/histograms a 0. Solo para tests. En producción
 * sería un memory leak controlado: cada test crea valores nuevos que prom
 * acumula salvo que se llame esto en `beforeEach`.
 */
export function resetMetrics(): void {
  turnProcessedTotal.reset();
  rateLimitHitTotal.reset();
  identityNotFoundTotal.reset();
  subgraphEnteredTotal.reset();
  persistTurnTotal.reset();
  takeoverTotal.reset();
  takeoverMutedTotal.reset();
  roleProfileMismatchTotal.reset();
  pipelineLatencyMs.reset();
}
