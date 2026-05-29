import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { ParguitoClient } from '../../../src/clients/ParguitoClient.js';
import type { ResolveIdentityOutput } from '../../../src/clients/types/GuacucoTypes.js';
import { env } from '../../../src/config/env.js';
import { IdentityNotFoundError } from '../../../src/core/errors/IdentityNotFoundError.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../src/core/types/CrmContext.js';
import type { Outcome } from '../../../src/core/types/Outcome.js';
import type { CompiledGraph } from '../../../src/graph/compile.js';
import {
  metricsRegistry,
  resetMetrics,
} from '../../../src/infrastructure/observability/metrics.js';
import type { DedupStore } from '../../../src/infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../../../src/infrastructure/redis/RateLimitStore.js';
import type { TakeoverStore } from '../../../src/infrastructure/redis/TakeoverStore.js';
import type { ConversationPersister } from '../../../src/pregraph/ConversationPersister.js';
import type { ResponseDispatcher } from '../../../src/pregraph/ResponseDispatcher.js';
import type { TakeoverNotifier } from '../../../src/pregraph/TakeoverNotifier.js';
import type { ThreadResolver } from '../../../src/pregraph/ThreadResolver.js';
import { Pipeline } from '../../../src/pregraph/pipeline.js';

async function metric(name: string, labels: Record<string, string>): Promise<number> {
  const all = await metricsRegistry.getMetricsAsJSON();
  const found = all.find((m) => m.name === name);
  if (!found?.values) return 0;
  for (const v of found.values) {
    const match = Object.entries(labels).every(([k, val]) => v.labels?.[k] === val);
    if (match) return Number(v.value);
  }
  return 0;
}

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText: 'hola',
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload: null,
    ...overrides,
  };
}

function fullIdentity(overrides?: Partial<ResolveIdentityOutput>): ResolveIdentityOutput {
  return {
    userUuid: 'usr-1',
    userName: 'Juan',
    userPhone: '54911000000',
    userTimezone: 'America/Argentina/Buenos_Aires',
    userLanguage: 'es',
    profileType: 'client',
    profileData: { client_uuid: 'cli-1' },
    preferences: { working_hours: null },
    businessStaffRoles: {
      business_uuid: 'biz-1',
      business_allia_id: 'allia-1',
      business_name: 'Test Biz',
      business_summary: null,
      general_comments: null,
      platform_id: 1,
      agent_name: 'Bot',
      business_country_code: 'AR',
      staff_uuid: 'stf-1',
      role: 'owner',
      role_id: 1,
      is_active: true,
      services: [],
    },
    helpersLists: [],
    channelData: null,
    isNewUser: false,
    welcomeMessage: null,
    onboardingUrl: null,
    ...overrides,
  };
}

function makeDeps() {
  const dedup = { isDuplicate: vi.fn().mockResolvedValue(false) };
  const rateLimit = {
    checkLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1, remaining: 19, limit: 20 }),
  };
  const guacuco = { resolveIdentity: vi.fn() };
  const parguito = { getCrmContext: vi.fn().mockResolvedValue(EMPTY_CRM_CONTEXT) };
  const dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const persister = { persistTurn: vi.fn().mockResolvedValue(undefined) };
  const takeover = {
    isHumanControlled: vi.fn().mockResolvedValue(false),
    mirrorActive: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    bumpFailures: vi.fn().mockResolvedValue(1),
    resetFailures: vi.fn().mockResolvedValue(undefined),
  };
  const takeoverNotifier = { trigger: vi.fn().mockResolvedValue(undefined) };
  const threadResolver = {
    buildThreadId: vi.fn().mockReturnValue('biz-1:cli-1:whatsapp:1'),
    resolve: vi.fn().mockResolvedValue({
      threadId: 'biz-1:cli-1:whatsapp:1',
      hasActiveCheckpoint: false,
      wasExpired: false,
    }),
  };
  const graph = {
    invoke: vi.fn().mockResolvedValue({
      outcome: {
        action: 'response',
        pendingReply: { text: '[grafo] Recibido (cliente): "hola"' },
      } satisfies Outcome,
    }),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  return {
    deps: {
      dedup: dedup as unknown as DedupStore,
      rateLimit: rateLimit as unknown as RateLimitStore,
      guacuco: guacuco as unknown as GuacucoClient,
      parguito: parguito as unknown as ParguitoClient,
      threadResolver: threadResolver as unknown as ThreadResolver,
      graph: graph as unknown as CompiledGraph,
      dispatcher: dispatcher as unknown as ResponseDispatcher,
      persister: persister as unknown as ConversationPersister,
      takeover: takeover as unknown as TakeoverStore,
      takeoverNotifier: takeoverNotifier as unknown as TakeoverNotifier,
      logger,
    },
    mocks: {
      dedup,
      rateLimit,
      guacuco,
      parguito,
      threadResolver,
      graph,
      dispatcher,
      persister,
      takeover,
      takeoverNotifier,
      logger,
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe('Pipeline.process', () => {
  it('returns ignored on duplicate message', async () => {
    const { deps, mocks } = makeDeps();
    mocks.dedup.isDuplicate.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('ignored');
    expect(mocks.guacuco.resolveIdentity).not.toHaveBeenCalled();
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
    expect(mocks.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns ignored (silent skip) on IdentityNotFoundError', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockRejectedValue(new IdentityNotFoundError());
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('ignored');
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
  });

  it('dispatches welcome flow for new staff (isNewUser=true)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({
        isNewUser: true,
        welcomeMessage: 'Bienvenido Juan',
        onboardingUrl: 'https://onboard.example/x',
        profileType: 'staff',
        profileData: { staff_uuid: 'stf-1' },
      }),
    );
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('response');
    expect(outcome.pendingReply?.cta).toBeDefined();
    expect(mocks.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
  });

  it('dispatches rate_limited when over limit', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.rateLimit.checkLimit.mockResolvedValue({
      allowed: false,
      count: 21,
      remaining: 0,
      limit: 20,
    });
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('rate_limited');
    expect(mocks.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
  });

  it('P3: drops turn (ignored) when inbound role mismatches resolved profileType', async () => {
    const { deps, mocks } = makeDeps();
    // Línea de clientes (channelMeta.role='client' por default) pero Guacuco
    // resuelve staff → fail-closed.
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({ profileType: 'staff', profileData: { staff_uuid: 'stf-1' } }),
    );
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(
      makeMessage({ channelMeta: { phoneNumberId: 'pn-1', role: 'client' } }),
    );
    expect(outcome.action).toBe('ignored');
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
    expect(mocks.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
    expect(await metric('isladeplata_role_profile_mismatch_total', { channel: 'whatsapp' })).toBe(
      1,
    );
  });

  it('P3: proceeds when inbound role matches profileType (staff line + staff)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({ profileType: 'staff', profileData: { staff_uuid: 'stf-1' } }),
    );
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(
      makeMessage({ channelMeta: { phoneNumberId: 'pn-staff-1', role: 'staff' } }),
    );
    expect(outcome.action).toBe('response');
    expect(mocks.graph.invoke).toHaveBeenCalledTimes(1);
  });

  it('P3: does not block when the message carries no role (non-WhatsApp meta)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage({ channelMeta: undefined }));
    expect(outcome.action).toBe('response');
    expect(mocks.graph.invoke).toHaveBeenCalledTimes(1);
  });

  it('happy path: invokes graph and dispatches outcome', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage({ contentText: 'hola mundo' }));
    expect(outcome.action).toBe('response');
    // PARGUITO_ENABLED default false → pipeline skips el roundtrip y pasa
    // EMPTY_CRM_CONTEXT directo. El call solo ocurre con flag=true.
    expect(mocks.parguito.getCrmContext).not.toHaveBeenCalled();
    expect(mocks.threadResolver.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.graph.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const [initialState] = mocks.graph.invoke.mock.calls[0] ?? [];
    expect((initialState as { crmContext: unknown }).crmContext).toEqual(EMPTY_CRM_CONTEXT);
  });

  it('augments crmContext.upcomingAppointments from Guacuco profileData.appointments', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({
        profileData: {
          client_uuid: 'cli-1',
          appointments: [
            { appointment_uuid: 'apt-1', description: 'Corte mañana 15h' },
            { appointment_uuid: 'apt-2', description: 'Color viernes' },
          ],
        },
      }),
    );
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    const [initialState] = mocks.graph.invoke.mock.calls[0] ?? [];
    expect((initialState as { crmContext: unknown }).crmContext).toEqual({
      upcomingAppointments: [
        { appointmentUuid: 'apt-1', description: 'Corte mañana 15h' },
        { appointmentUuid: 'apt-2', description: 'Color viernes' },
      ],
      profileMeta: {},
    });
    // Parguito sigue sin llamarse (flag off); los turnos vienen de Guacuco.
    expect(mocks.parguito.getCrmContext).not.toHaveBeenCalled();
  });

  it('drops malformed Guacuco appointments (missing uuid/description)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({
        profileData: {
          client_uuid: 'cli-1',
          appointments: [
            { appointment_uuid: 'apt-1', description: 'Válido' },
            { appointment_uuid: '', description: 'Sin uuid' },
            { appointment_uuid: 'apt-3', description: '' },
          ],
        },
      }),
    );
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    const [initialState] = mocks.graph.invoke.mock.calls[0] ?? [];
    expect(
      (initialState as { crmContext: { upcomingAppointments: unknown[] } }).crmContext
        .upcomingAppointments,
    ).toEqual([{ appointmentUuid: 'apt-1', description: 'Válido' }]);
  });

  it('passes identity + crmContext + channelMessage to graph.invoke', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    const message = makeMessage();
    await pipeline.process(message);

    const [initialState, config] = mocks.graph.invoke.mock.calls[0] ?? [];
    expect(initialState).toMatchObject({
      input: { channelMessage: message, receivedAt: message.receivedAt },
      identity: {
        tenantUuid: 'biz-1',
        tenantAlliaId: 'allia-1',
        profileUuid: 'cli-1',
        profileType: 'client',
        platformId: 1,
        channel: 'whatsapp',
        timezone: 'America/Argentina/Buenos_Aires',
        roleId: 1,
      },
    });
    expect(config).toEqual({ configurable: { thread_id: 'biz-1:cli-1:whatsapp:1' } });
  });

  it('returns ignored when graph result has no outcome', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({ outcome: null });
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('ignored');
  });

  it('catches unexpected errors and dispatches generic error', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockRejectedValue(
      new ToolExecutionError('guacuco_invalid_envelope', 'kaboom'),
    );
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('error');
    expect(mocks.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('ignores when identity is missing critical fields', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity({ businessStaffRoles: null }));
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('ignored');
    expect(mocks.rateLimit.checkLimit).not.toHaveBeenCalled();
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
  });
});

describe('Pipeline.process — metrics (H8.2)', () => {
  beforeEach(() => resetMetrics());

  it('turnProcessed increments with outcome_action=response on happy path', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(
      await metric('isladeplata_turn_processed_total', {
        channel: 'whatsapp',
        outcome_action: 'response',
      }),
    ).toBe(1);
  });

  it('turnProcessed increments with outcome_action=ignored on duplicate', async () => {
    const { deps, mocks } = makeDeps();
    mocks.dedup.isDuplicate.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(
      await metric('isladeplata_turn_processed_total', {
        channel: 'whatsapp',
        outcome_action: 'ignored',
      }),
    ).toBe(1);
  });

  it('identityNotFound increments on IdentityNotFoundError silent skip', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockRejectedValue(new IdentityNotFoundError());
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(await metric('isladeplata_identity_not_found_total', { channel: 'whatsapp' })).toBe(1);
  });

  it('rateLimitHit increments on rate_limited path', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.rateLimit.checkLimit.mockResolvedValue({
      allowed: false,
      count: 21,
      remaining: 0,
      limit: 20,
    });
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(await metric('isladeplata_rate_limit_hit_total', { channel: 'whatsapp' })).toBe(1);
    expect(
      await metric('isladeplata_turn_processed_total', {
        channel: 'whatsapp',
        outcome_action: 'rate_limited',
      }),
    ).toBe(1);
  });

  it('subgraphEntered increments with activeSubgraph from graph routing', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: { action: 'response', pendingReply: { text: 'ok' } } satisfies Outcome,
      routing: { activeSubgraph: 'schedule' },
    });
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(await metric('isladeplata_subgraph_entered_total', { subgraph: 'schedule' })).toBe(1);
  });

  it('subgraphEntered increments with subgraph=welcome on new staff', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({
        isNewUser: true,
        welcomeMessage: 'Bienvenido Juan',
        onboardingUrl: 'https://x',
        profileType: 'staff',
        profileData: { staff_uuid: 'stf-1' },
      }),
    );
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    expect(await metric('isladeplata_subgraph_entered_total', { subgraph: 'welcome' })).toBe(1);
  });

  it('pipelineLatencyMs observes a sample per processed turn', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toMatch(
      /isladeplata_pipeline_latency_ms_count\{outcome_action="response"\} 1/,
    );
  });
});

describe('Pipeline.process — persistence (H8.1, step 9)', () => {
  it('persists user+assistant after graph dispatch with subgraph metadata', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: { action: 'response', pendingReply: { text: 'ok' } } satisfies Outcome,
      routing: { activeSubgraph: 'schedule' },
    });
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage({ contentText: 'quiero un turno' }));

    expect(mocks.persister.persistTurn).toHaveBeenCalledTimes(1);
    const [persistMessage, persistIdentity, persistOutcome, persistMeta] =
      mocks.persister.persistTurn.mock.calls[0] ?? [];
    expect(persistMessage?.contentText).toBe('quiero un turno');
    expect(persistIdentity?.tenantAlliaId).toBe('allia-1');
    expect(persistOutcome?.action).toBe('response');
    expect(persistMeta).toEqual({ subgraph: 'schedule' });
  });

  it('omits subgraph metadata when routing has no activeSubgraph (fast-path social)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: { action: 'response', pendingReply: { text: 'hola!' } } satisfies Outcome,
      routing: {},
    });
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.persister.persistTurn).toHaveBeenCalledTimes(1);
    const persistMeta = mocks.persister.persistTurn.mock.calls[0]?.[3];
    expect(persistMeta).toEqual({});
  });

  it('persists rate_limited outcome with full identity', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.rateLimit.checkLimit.mockResolvedValue({
      allowed: false,
      count: 21,
      remaining: 0,
      limit: 20,
    });
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());

    expect(outcome.action).toBe('rate_limited');
    expect(mocks.persister.persistTurn).toHaveBeenCalledTimes(1);
    const persistOutcome = mocks.persister.persistTurn.mock.calls[0]?.[2];
    expect(persistOutcome?.action).toBe('rate_limited');
  });

  it('persists welcome flow turn with subgraph=welcome', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({
        isNewUser: true,
        welcomeMessage: 'Bienvenido Juan',
        onboardingUrl: 'https://onboard.example/x',
        profileType: 'staff',
        profileData: { staff_uuid: 'stf-1' },
      }),
    );
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.persister.persistTurn).toHaveBeenCalledTimes(1);
    const persistMeta = mocks.persister.persistTurn.mock.calls[0]?.[3];
    expect(persistMeta).toEqual({ subgraph: 'welcome' });
  });

  it('does NOT persist on duplicate / silent skip (no identity)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.dedup.isDuplicate.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.persister.persistTurn).not.toHaveBeenCalled();
  });

  it('does NOT persist when identity is missing critical fields', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity({ businessStaffRoles: null }));
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.persister.persistTurn).not.toHaveBeenCalled();
  });

  it('pipeline does not crash when persister rejects (fire-and-forget)', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.persister.persistTurn.mockRejectedValue(new Error('persist failed'));
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('response');
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Pipeline takeover (P-human-takeover)', () => {
  beforeEach(() => {
    resetMetrics();
    env.HUMAN_TAKEOVER_ENABLED = true;
  });
  afterEach(() => {
    env.HUMAN_TAKEOVER_ENABLED = false;
  });

  it('gate: silences the bot (ignored + persisted) when thread is human_controlled', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.takeover.isHumanControlled.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());

    expect(outcome.action).toBe('ignored');
    // El turno entrante se persiste para el historial del dashboard...
    expect(mocks.persister.persistTurn).toHaveBeenCalledTimes(1);
    // ...pero el bot NO invoca el grafo ni responde.
    expect(mocks.graph.invoke).not.toHaveBeenCalled();
    expect(mocks.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(await metric('isladeplata_takeover_muted_total', { channel: 'whatsapp' })).toBe(1);
  });

  it('gate: does NOT silence when flag is off (even if mirror says controlled)', async () => {
    env.HUMAN_TAKEOVER_ENABLED = false;
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.takeover.isHumanControlled.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.takeover.isHumanControlled).not.toHaveBeenCalled();
    expect(mocks.graph.invoke).toHaveBeenCalled();
  });

  it('gate: repopulates the mirror when Guacuco reports humanControlled.active', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({ humanControlled: { active: true, expiresAt: null } }),
    );
    mocks.takeover.isHumanControlled.mockResolvedValue(true);
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.takeover.mirrorActive).toHaveBeenCalledWith('biz-1:cli-1:whatsapp:1');
  });

  it('gate: invalidates the mirror when Guacuco reports humanControlled.active=false', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(
      fullIdentity({ humanControlled: { active: false, expiresAt: null } }),
    );
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());

    expect(mocks.takeover.clear).toHaveBeenCalledWith('biz-1:cli-1:whatsapp:1');
  });

  it('layer A/C: triggers takeover from outcome.takeover signal', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: {
        action: 'handed_off',
        pendingReply: { text: 'Te conecto con una persona.' },
        takeover: { reasonCode: 'explicit_request' },
      },
    });
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    await flush();

    expect(mocks.takeoverNotifier.trigger).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1:cli-1:whatsapp:1',
      expect.anything(),
      'explicit_request',
      null,
    );
    // No cuenta como falla del bot.
    expect(mocks.takeover.bumpFailures).not.toHaveBeenCalled();
  });

  it('layer B: triggers takeover when consecutive failures reach the threshold', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: { action: 'error', pendingReply: { text: 'Ups' } },
    });
    mocks.takeover.bumpFailures.mockResolvedValue(3); // == TAKEOVER_FAILS_THRESHOLD
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    await flush();

    expect(mocks.takeover.bumpFailures).toHaveBeenCalledWith('biz-1:cli-1:whatsapp:1');
    expect(mocks.takeoverNotifier.trigger).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1:cli-1:whatsapp:1',
      expect.anything(),
      'repeated_failures',
      null,
    );
  });

  it('layer B: does NOT trigger below the threshold', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    mocks.graph.invoke.mockResolvedValue({
      outcome: { action: 'handed_off', pendingReply: { text: 'no disponible' } },
    });
    mocks.takeover.bumpFailures.mockResolvedValue(1);
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    await flush();

    expect(mocks.takeoverNotifier.trigger).not.toHaveBeenCalled();
  });

  it('layer B: resets the failure counter on a successful outcome', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    // graph default mock returns a 'response' outcome.
    const pipeline = new Pipeline(deps);

    await pipeline.process(makeMessage());
    await flush();

    expect(mocks.takeover.resetFailures).toHaveBeenCalledWith('biz-1:cli-1:whatsapp:1');
    expect(mocks.takeoverNotifier.trigger).not.toHaveBeenCalled();
  });
});
