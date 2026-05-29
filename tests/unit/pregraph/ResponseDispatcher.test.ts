import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import type {
  OutboundChannelAdapter,
  OutboundChannelRegistry,
} from '../../../src/core/types/OutboundChannel.js';
import type { Outcome } from '../../../src/core/types/Outcome.js';
import { ResponseDispatcher } from '../../../src/pregraph/ResponseDispatcher.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeMessage(channelType: ChannelMessage['channelType']): ChannelMessage {
  return {
    channelType,
    channelId: '549111',
    messageId: 'wamid.in',
    contentType: 'text',
    contentText: 'hi',
    receivedAt: '2026-01-01T00:00:00.000Z',
    channelMeta: { phoneNumberId: 'PNID' },
  };
}

function makeAdapter(channelType: ChannelMessage['channelType']) {
  const replyTo = vi.fn().mockResolvedValue(undefined);
  const adapter = {
    channelType,
    replyTo,
    sendProactive: vi.fn(),
  } as unknown as OutboundChannelAdapter;
  return { adapter, replyTo };
}

const reply: Outcome = { action: 'response', pendingReply: { text: 'hola' } };

afterEach(() => vi.clearAllMocks());

describe('ResponseDispatcher', () => {
  it('resolves the adapter by channelType and delegates to replyTo', async () => {
    const { adapter, replyTo } = makeAdapter('whatsapp');
    const registry: OutboundChannelRegistry = new Map([['whatsapp', adapter]]);
    const message = makeMessage('whatsapp');
    await new ResponseDispatcher(registry, mockLogger).dispatch(message, reply);
    expect(replyTo).toHaveBeenCalledWith(message, reply.pendingReply);
  });

  it('dispatches to a non-whatsapp channel via the registry (no `if whatsapp`)', async () => {
    const { adapter, replyTo } = makeAdapter('telegram');
    const registry: OutboundChannelRegistry = new Map([['telegram', adapter]]);
    const message = makeMessage('telegram');
    await new ResponseDispatcher(registry, mockLogger).dispatch(message, reply);
    expect(replyTo).toHaveBeenCalledWith(message, reply.pendingReply);
  });

  it('warns and does not throw when no adapter is registered for the channel', async () => {
    const registry: OutboundChannelRegistry = new Map();
    await expect(
      new ResponseDispatcher(registry, mockLogger).dispatch(makeMessage('whatsapp'), reply),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the outcome has no pendingReply', async () => {
    const { adapter, replyTo } = makeAdapter('whatsapp');
    const registry: OutboundChannelRegistry = new Map([['whatsapp', adapter]]);
    await new ResponseDispatcher(registry, mockLogger).dispatch(makeMessage('whatsapp'), {
      action: 'ignored',
    });
    expect(replyTo).not.toHaveBeenCalled();
  });
});
