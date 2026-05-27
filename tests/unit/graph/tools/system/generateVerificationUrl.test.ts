import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import { generateVerificationUrl } from '../../../../../src/graph/tools/system/generateVerificationUrl.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-xyz',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeState(profileType: Identity['profileType'] = 'client'): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentText: 'verificar',
    receivedAt: new Date().toISOString(),
    whatsappChannel: profileType === 'staff' ? 'staff' : 'client',
    phoneNumberId: 'pn-1',
    interactivePayload: null,
  };
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: { ...IDENTITY, profileType },
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

describe('generateVerificationUrl tool', () => {
  it('returns CTA outcome for client', async () => {
    const executeTool = vi.fn(async () => ({ url: 'https://verify.app/abc' }));
    const update = await generateVerificationUrl.run(makeState('client'), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.pendingReply?.cta?.url).toBe('https://verify.app/abc');
    expect(update.outcome?.pendingReply?.cta?.displayText).toBe('Verificar');
  });

  it('works for staff role too (allowedRoles includes both)', async () => {
    const executeTool = vi.fn(async () => ({ url: 'https://verify.app/staff' }));
    const update = await generateVerificationUrl.run(makeState('staff'), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('response');
  });

  it('declares both roles', () => {
    expect(generateVerificationUrl.allowedRoles).toEqual(['client', 'staff']);
  });

  it('returns error on backend failure', async () => {
    const executeTool = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await generateVerificationUrl.run(makeState(), {
      guacuco: makeGuacuco(executeTool as unknown as GuacucoClient['executeTool']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
  });
});
