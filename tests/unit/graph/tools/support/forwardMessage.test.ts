import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import { forwardMessage } from '../../../../../src/graph/tools/support/forwardMessage.js';

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

function makeState(contentText: string): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText,
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

function makeGuacuco(impl: GuacucoClient['forwardMessage']): GuacucoClient {
  return { forwardMessage: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('forwardMessage tool', () => {
  it('forwards sanitized text and returns confirmation', async () => {
    const forward = vi.fn(async () => ({}));
    const update = await forwardMessage.run(makeState('Estoy en la <b>puerta</b>'), {
      guacuco: makeGuacuco(forward as unknown as GuacucoClient['forwardMessage']),
      logger: mockLogger,
    });
    expect(forward).toHaveBeenCalledWith('Estoy en la puerta', IDENTITY); // HTML stripped by sanitizeUserInput
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toMatch(/enviado al negocio/i);
  });

  it('returns ignored on empty input (nothing to forward)', async () => {
    const forward = vi.fn();
    const update = await forwardMessage.run(makeState('   '), {
      guacuco: makeGuacuco(forward as unknown as GuacucoClient['forwardMessage']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('ignored');
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns error when identity is incomplete', async () => {
    const state = makeState('mensaje');
    state.identity = { ...IDENTITY, tenantAlliaId: '' };
    const forward = vi.fn();
    const update = await forwardMessage.run(state, {
      guacuco: makeGuacuco(forward as unknown as GuacucoClient['forwardMessage']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns error on backend failure', async () => {
    const forward = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await forwardMessage.run(makeState('hola'), {
      guacuco: makeGuacuco(forward as unknown as GuacucoClient['forwardMessage']),
      logger: mockLogger,
    });
    expect(update.outcome?.action).toBe('error');
  });

  it('declares both roles', () => {
    expect(forwardMessage.allowedRoles).toEqual(['client', 'staff']);
  });
});
