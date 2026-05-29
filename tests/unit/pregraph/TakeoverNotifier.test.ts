import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import {
  metricsRegistry,
  resetMetrics,
} from '../../../src/infrastructure/observability/metrics.js';
import type { TakeoverStore } from '../../../src/infrastructure/redis/TakeoverStore.js';
import { TakeoverNotifier } from '../../../src/pregraph/TakeoverNotifier.js';

async function metric(name: string, labels: Record<string, string>): Promise<number> {
  const all = await metricsRegistry.getMetricsAsJSON();
  const found = all.find((m) => m.name === name);
  if (!found?.values) return 0;
  for (const v of found.values) {
    if (Object.entries(labels).every(([k, val]) => v.labels?.[k] === val)) return Number(v.value);
  }
  return 0;
}

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'cli-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const THREAD = 'biz-1:cli-1:whatsapp:1';

function makeMessage(text: string): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText: text,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload: null,
  };
}

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeNotifier() {
  const guacuco = {
    triggerTakeover: vi.fn().mockResolvedValue({ takeover_id: 'tk-1', created: true }),
  };
  const store = { mirrorActive: vi.fn().mockResolvedValue(undefined) };
  const notifier = new TakeoverNotifier(
    guacuco as unknown as GuacucoClient,
    store as unknown as TakeoverStore,
    mockLogger,
  );
  return { notifier, guacuco, store };
}

beforeEach(() => resetMetrics());
afterEach(() => vi.clearAllMocks());

describe('TakeoverNotifier.trigger', () => {
  it('posts to Guacuco and mirrors in Redis on success', async () => {
    const { notifier, guacuco, store } = makeNotifier();

    await notifier.trigger(
      IDENTITY,
      THREAD,
      makeMessage('quiero un humano'),
      'explicit_request',
      null,
    );

    expect(guacuco.triggerTakeover).toHaveBeenCalledTimes(1);
    expect(store.mirrorActive).toHaveBeenCalledWith(THREAD);
    expect(
      await metric('isladeplata_takeover_total', {
        reason_code: 'explicit_request',
        result: 'created',
      }),
    ).toBe(1);
  });

  it('counts created:false as "duplicate" and still mirrors', async () => {
    const { notifier, guacuco, store } = makeNotifier();
    guacuco.triggerTakeover.mockResolvedValue({ takeover_id: 'tk-1', created: false });

    await notifier.trigger(IDENTITY, THREAD, makeMessage('hola'), 'repeated_failures', 'schedule');

    expect(store.mirrorActive).toHaveBeenCalledWith(THREAD);
    expect(
      await metric('isladeplata_takeover_total', {
        reason_code: 'repeated_failures',
        result: 'duplicate',
      }),
    ).toBe(1);
  });

  it('is fire-and-forget: resolves (no throw) and does NOT mirror when Guacuco fails', async () => {
    const { notifier, guacuco, store } = makeNotifier();
    guacuco.triggerTakeover.mockRejectedValue(new Error('Guacuco down'));

    await expect(
      notifier.trigger(IDENTITY, THREAD, makeMessage('hola'), 'explicit_request', null),
    ).resolves.toBeUndefined();

    // El bot sigue atendiendo: no se silencia una conversación que el dashboard no verá.
    expect(store.mirrorActive).not.toHaveBeenCalled();
    expect(
      await metric('isladeplata_takeover_total', {
        reason_code: 'explicit_request',
        result: 'error',
      }),
    ).toBe(1);
  });
});

describe('TakeoverNotifier.buildPayload', () => {
  it('builds a deterministic, PII-masked payload', () => {
    const { notifier } = makeNotifier();
    const payload = notifier.buildPayload(
      IDENTITY,
      THREAD,
      makeMessage('llamame al 54911223344 porfa'),
      'sentiment_frustration',
      'cancel',
    );

    expect(payload.tenant_allia_id).toBe('allia-1');
    expect(payload.thread_id).toBe(THREAD);
    expect(payload.profile_uuid).toBe('cli-1');
    expect(payload.profile_type).toBe('client');
    expect(payload.channel).toBe('whatsapp');
    expect(payload.platform_id).toBe(1);
    expect(payload.reason_code).toBe('sentiment_frustration');
    expect(payload.subgraph).toBe('cancel');
    // Summary determinístico (sin PII), distinto por reason.
    expect(payload.summary).toContain('frustración');
    // Último mensaje enmascarado (no contiene el número completo).
    expect(payload.last_user_message).not.toContain('54911223344');
    expect(payload.ttl_seconds).toBeGreaterThan(0);
    // idempotency_key prefijado con el thread_id.
    expect(payload.idempotency_key.startsWith(`${THREAD}:`)).toBe(true);
  });
});
