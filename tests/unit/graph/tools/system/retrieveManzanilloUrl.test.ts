import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import { retrieveManzanilloUrl } from '../../../../../src/graph/tools/system/retrieveManzanilloUrl.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-abc',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeState(): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentText: 'quiero el link',
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
    interactivePayload: null,
  };
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: IDENTITY,
    crmContext: EMPTY_CRM_CONTEXT,
    routing: { messageType: 'action', intent: 'unknown', confidence: 0.6 },
    subgraphState: null,
    outcome: null,
  };
}

function makeGuacuco(impl: GuacucoClient['executeTool']): GuacucoClient {
  return { executeTool: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('retrieveManzanilloUrl tool', () => {
  it('returns CTA outcome with URL on happy path', async () => {
    const executeTool = vi.fn(async () => ({ url: 'https://manzanillo.app/abc' }));
    const update = await retrieveManzanilloUrl.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.cta?.url).toBe('https://manzanillo.app/abc');
    expect(update.outcome?.pendingReply?.cta?.displayText).toBe('Abrir');
    expect(executeTool).toHaveBeenCalledWith(
      'retrieve_manzanillo_url',
      {},
      { context: { profile_uuid: 'profile-abc' } },
    );
  });

  it('returns error outcome when Guacuco throws', async () => {
    const executeTool = vi.fn(async () => {
      throw new Error('upstream 500');
    });
    const update = await retrieveManzanilloUrl.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
    expect(update.outcome?.pendingReply?.text).toContain('link');
  });

  it('returns error outcome when result lacks url', async () => {
    const executeTool = vi.fn(async () => ({}));
    const update = await retrieveManzanilloUrl.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
  });

  it('returns error outcome when identity is missing profileUuid', async () => {
    const state = makeState();
    state.identity = { ...IDENTITY, profileUuid: '' };
    const executeTool = vi.fn();
    const update = await retrieveManzanilloUrl.run(state, {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('declares client role only', () => {
    expect(retrieveManzanilloUrl.allowedRoles).toEqual(['client']);
  });
});
