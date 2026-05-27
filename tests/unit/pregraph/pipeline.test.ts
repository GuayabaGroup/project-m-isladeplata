import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { ParguitoClient } from '../../../src/clients/ParguitoClient.js';
import type { ResolveIdentityOutput } from '../../../src/clients/types/GuacucoTypes.js';
import { IdentityNotFoundError } from '../../../src/core/errors/IdentityNotFoundError.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../src/core/types/CrmContext.js';
import type { DedupStore } from '../../../src/infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../../../src/infrastructure/redis/RateLimitStore.js';
import { EchoResponder } from '../../../src/pregraph/EchoResponder.js';
import type { ResponseDispatcher } from '../../../src/pregraph/ResponseDispatcher.js';
import { Pipeline } from '../../../src/pregraph/pipeline.js';

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: 'wamid.1',
    contentText: 'hola',
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
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
  const echoResponder = new EchoResponder();
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
      echoResponder,
      dispatcher: dispatcher as unknown as ResponseDispatcher,
      logger,
    },
    mocks: { dedup, rateLimit, guacuco, parguito, dispatcher, logger },
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
    expect(mocks.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns ignored (silent skip) on IdentityNotFoundError', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockRejectedValue(new IdentityNotFoundError());
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage());
    expect(outcome.action).toBe('ignored');
    expect(mocks.dispatcher.dispatch).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit.checkLimit).not.toHaveBeenCalled();
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
    expect(mocks.parguito.getCrmContext).not.toHaveBeenCalled();
  });

  it('happy path: echo response with CRM context loaded', async () => {
    const { deps, mocks } = makeDeps();
    mocks.guacuco.resolveIdentity.mockResolvedValue(fullIdentity());
    const pipeline = new Pipeline(deps);

    const outcome = await pipeline.process(makeMessage({ contentText: 'hola mundo' }));
    expect(outcome.action).toBe('response');
    expect(outcome.pendingReply?.text).toContain('hola mundo');
    expect(mocks.parguito.getCrmContext).toHaveBeenCalledWith('cli-1');
    expect(mocks.dispatcher.dispatch).toHaveBeenCalledTimes(1);
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
  });
});
