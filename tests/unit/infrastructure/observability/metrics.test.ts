import { beforeEach, describe, expect, it } from 'vitest';
import {
  identityNotFoundTotal,
  metricsRegistry,
  persistTurnTotal,
  pipelineLatencyMs,
  rateLimitHitTotal,
  resetMetrics,
  subgraphEnteredTotal,
  turnProcessedTotal,
} from '../../../../src/infrastructure/observability/metrics.js';

async function getMetricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await metricsRegistry.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found?.values) return 0;
  for (const v of found.values) {
    const match = Object.entries(labels).every(([k, val]) => v.labels?.[k] === val);
    if (match) return Number(v.value);
  }
  return 0;
}

beforeEach(() => {
  resetMetrics();
});

describe('metrics module', () => {
  it('turnProcessedTotal increments by channel + outcome_action', async () => {
    turnProcessedTotal.labels({ channel: 'whatsapp', outcome_action: 'response' }).inc();
    turnProcessedTotal.labels({ channel: 'whatsapp', outcome_action: 'response' }).inc();
    turnProcessedTotal.labels({ channel: 'whatsapp', outcome_action: 'ignored' }).inc();

    const respCount = await getMetricValue('isladeplata_turn_processed_total', {
      channel: 'whatsapp',
      outcome_action: 'response',
    });
    const ignoredCount = await getMetricValue('isladeplata_turn_processed_total', {
      channel: 'whatsapp',
      outcome_action: 'ignored',
    });
    expect(respCount).toBe(2);
    expect(ignoredCount).toBe(1);
  });

  it('rateLimitHitTotal increments by channel', async () => {
    rateLimitHitTotal.labels({ channel: 'whatsapp' }).inc();
    const count = await getMetricValue('isladeplata_rate_limit_hit_total', {
      channel: 'whatsapp',
    });
    expect(count).toBe(1);
  });

  it('identityNotFoundTotal increments by channel', async () => {
    identityNotFoundTotal.labels({ channel: 'whatsapp' }).inc();
    identityNotFoundTotal.labels({ channel: 'whatsapp' }).inc();
    const count = await getMetricValue('isladeplata_identity_not_found_total', {
      channel: 'whatsapp',
    });
    expect(count).toBe(2);
  });

  it('subgraphEnteredTotal increments by subgraph name', async () => {
    subgraphEnteredTotal.labels({ subgraph: 'schedule' }).inc();
    subgraphEnteredTotal.labels({ subgraph: 'query' }).inc();
    expect(
      await getMetricValue('isladeplata_subgraph_entered_total', { subgraph: 'schedule' }),
    ).toBe(1);
    expect(await getMetricValue('isladeplata_subgraph_entered_total', { subgraph: 'query' })).toBe(
      1,
    );
  });

  it('persistTurnTotal increments by result (ok/error)', async () => {
    persistTurnTotal.labels({ result: 'ok' }).inc();
    persistTurnTotal.labels({ result: 'ok' }).inc();
    persistTurnTotal.labels({ result: 'error' }).inc();
    expect(await getMetricValue('isladeplata_persist_turn_total', { result: 'ok' })).toBe(2);
    expect(await getMetricValue('isladeplata_persist_turn_total', { result: 'error' })).toBe(1);
  });

  it('pipelineLatencyMs observes values + buckets', async () => {
    pipelineLatencyMs.labels({ outcome_action: 'response' }).observe(100);
    pipelineLatencyMs.labels({ outcome_action: 'response' }).observe(450);
    pipelineLatencyMs.labels({ outcome_action: 'response' }).observe(2200);
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toContain(
      'isladeplata_pipeline_latency_ms_count{outcome_action="response"} 3',
    );
    expect(exposition).toContain(
      'isladeplata_pipeline_latency_ms_sum{outcome_action="response"} 2750',
    );
  });

  it('resetMetrics zeroes counters and clears histogram observations', async () => {
    turnProcessedTotal.labels({ channel: 'whatsapp', outcome_action: 'response' }).inc();
    persistTurnTotal.labels({ result: 'ok' }).inc();
    pipelineLatencyMs.labels({ outcome_action: 'response' }).observe(100);

    resetMetrics();

    expect(
      await getMetricValue('isladeplata_turn_processed_total', {
        channel: 'whatsapp',
        outcome_action: 'response',
      }),
    ).toBe(0);
    expect(await getMetricValue('isladeplata_persist_turn_total', { result: 'ok' })).toBe(0);
    // Histogram count after reset is 0 (no observations remain).
    const exposition = await metricsRegistry.metrics();
    expect(exposition).not.toMatch(/isladeplata_pipeline_latency_ms_sum\{[^}]*\} [1-9]/);
  });

  it('exposition format is Prometheus text', async () => {
    turnProcessedTotal.labels({ channel: 'whatsapp', outcome_action: 'response' }).inc();
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toMatch(/# HELP isladeplata_turn_processed_total/);
    expect(exposition).toMatch(/# TYPE isladeplata_turn_processed_total counter/);
    expect(exposition).toContain(
      'isladeplata_turn_processed_total{channel="whatsapp",outcome_action="response"} 1',
    );
  });
});
