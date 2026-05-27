import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import { connectMercadoPago } from '../../../../../src/graph/tools/system/connectMercadoPago.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

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

function makeGuacuco(impl: GuacucoClient['executeTool']): GuacucoClient {
  return { executeTool: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('connectMercadoPago tool', () => {
  it('returns CTA with connect URL on happy path', async () => {
    const executeTool = vi.fn(async () => ({ url: 'https://mp.example/oauth/abc' }));
    const update = await connectMercadoPago.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.cta?.displayText).toBe('Conectar');
    expect(executeTool).toHaveBeenCalledWith(
      'connect_mercado_pago',
      {},
      { context: { business_allia_id: 'allia-1' } },
    );
  });

  it('declares staff role only', () => {
    expect(connectMercadoPago.allowedRoles).toEqual(['staff']);
  });

  it('returns error when tenantAlliaId missing', async () => {
    const state = makeState();
    state.identity = { ...IDENTITY_STAFF, tenantAlliaId: '' };
    const executeTool = vi.fn();
    const update = await connectMercadoPago.run(state, {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('returns error on backend failure', async () => {
    const executeTool = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await connectMercadoPago.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
  });
});
