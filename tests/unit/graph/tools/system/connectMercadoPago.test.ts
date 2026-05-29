import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { LlmProvider } from '../../../../../src/infrastructure/llm/LlmProvider.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import { connectMercadoPago } from '../../../../../src/graph/tools/system/connectMercadoPago.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Unused by system tools (only forward_message summarizes), but ToolDeps requires it.
const mockLlm = { complete: vi.fn() } as unknown as LlmProvider;

const IDENTITY_STAFF: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'staff-1',
  profileType: 'staff',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeState(): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText: 'conectar mercado pago',
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'staff',
    phoneNumberId: 'pn-1',
    interactivePayload: null,
  };
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: IDENTITY_STAFF,
    crmContext: EMPTY_CRM_CONTEXT,
    routing: { messageType: 'action', intent: 'unknown', confidence: 0.6 },
    subgraphState: null,
    outcome: null,
  };
}

function makeGuacuco(impl: GuacucoClient['connectMercadoPago']): GuacucoClient {
  return { connectMercadoPago: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('connectMercadoPago tool', () => {
  it('returns CTA with connect URL on happy path', async () => {
    const connect = vi.fn(async () => ({ url: 'https://mp.example/oauth/abc' }));
    const update = await connectMercadoPago.run(makeState(), {
      guacuco: makeGuacuco(connect as unknown as GuacucoClient['connectMercadoPago']),
      logger: mockLogger,
      llm: mockLlm,
    });
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.cta?.displayText).toBe('Conectar');
    expect(connect).toHaveBeenCalledWith(IDENTITY_STAFF);
  });

  it('declares staff role only', () => {
    expect(connectMercadoPago.allowedRoles).toEqual(['staff']);
  });

  it('returns error when profileUuid missing', async () => {
    const state = makeState();
    state.identity = { ...IDENTITY_STAFF, profileUuid: '' };
    const connect = vi.fn();
    const update = await connectMercadoPago.run(state, {
      guacuco: makeGuacuco(connect as unknown as GuacucoClient['connectMercadoPago']),
      logger: mockLogger,
      llm: mockLlm,
    });
    expect(update.outcome?.action).toBe('error');
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns error on backend failure', async () => {
    const connect = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await connectMercadoPago.run(makeState(), {
      guacuco: makeGuacuco(connect as unknown as GuacucoClient['connectMercadoPago']),
      logger: mockLogger,
      llm: mockLlm,
    });
    expect(update.outcome?.action).toBe('error');
  });
});
