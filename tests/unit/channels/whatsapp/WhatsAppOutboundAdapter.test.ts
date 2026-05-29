import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { createWhatsAppOutboundAdapter } from '../../../../src/channels/whatsapp/WhatsAppOutboundAdapter.js';
import type { WhatsAppSender } from '../../../../src/channels/whatsapp/sender.js';
import { IdpError } from '../../../../src/core/errors/IdpError.js';
import type { ChannelMessage } from '../../../../src/core/types/ChannelMessage.js';
import type { OutboundMessageDto } from '../../../../src/core/types/OutboundMessage.js';
import type { OutboundReply } from '../../../../src/core/types/Outcome.js';
import type { OutboundMessageBuilder } from '../../../../src/nlg/OutboundMessageBuilder.js';
import type { ResponseBuilder } from '../../../../src/nlg/ResponseBuilder.js';

vi.mock('../../../../src/config/channels.config.js', () => ({
  resolveWhatsAppPhoneByRole: vi.fn(),
  resolveWhatsAppByPhoneNumberId: vi.fn(),
}));

import {
  resolveWhatsAppByPhoneNumberId,
  resolveWhatsAppPhoneByRole,
} from '../../../../src/config/channels.config.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const builtMessage = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '549111',
  type: 'text',
  text: { body: 'hi' },
} as const;

function makeAdapter(overrides?: {
  buildForWhatsApp?: ReturnType<typeof vi.fn>;
  build?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
}) {
  const buildForWhatsApp = overrides?.buildForWhatsApp ?? vi.fn().mockReturnValue(builtMessage);
  const build = overrides?.build ?? vi.fn().mockReturnValue(builtMessage);
  const send = overrides?.send ?? vi.fn().mockResolvedValue('wamid.123');
  const adapter = createWhatsAppOutboundAdapter({
    responseBuilder: { buildForWhatsApp } as unknown as ResponseBuilder,
    outboundBuilder: { build } as unknown as OutboundMessageBuilder,
    sender: { send } as unknown as WhatsAppSender,
    logger: mockLogger,
  });
  return { adapter, buildForWhatsApp, build, send };
}

function makeMessage(channelMeta?: Record<string, string>): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '549111',
    messageId: 'wamid.in',
    contentType: 'text',
    contentText: 'hi',
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...(channelMeta ? { channelMeta } : {}),
  };
}

const reply: OutboundReply = { text: 'hola' };

const textDto: OutboundMessageDto = {
  channelType: 'whatsapp',
  to: '549111',
  role: 'client',
  platformId: 1,
  type: 'text',
  text: { body: 'hi' },
};

beforeEach(() => {
  vi.mocked(resolveWhatsAppPhoneByRole).mockReturnValue('PNID');
  vi.mocked(resolveWhatsAppByPhoneNumberId).mockReturnValue({
    accessToken: 'tok',
    role: 'client',
    platformId: 1,
  });
});

afterEach(() => vi.clearAllMocks());

describe('WhatsAppOutboundAdapter.replyTo', () => {
  it('formats and sends to the inbound author using channelMeta.phoneNumberId', async () => {
    const { adapter, send } = makeAdapter();
    await adapter.replyTo(makeMessage({ phoneNumberId: 'PNID', role: 'client' }), reply);
    expect(send).toHaveBeenCalledWith({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      message: builtMessage,
    });
  });

  it('warns and skips when channelMeta.phoneNumberId is missing', async () => {
    const { adapter, send } = makeAdapter();
    await adapter.replyTo(makeMessage(), reply);
    expect(send).not.toHaveBeenCalled();
  });

  it('warns and skips when the phoneNumberId is unknown', async () => {
    vi.mocked(resolveWhatsAppByPhoneNumberId).mockReturnValue(null);
    const { adapter, send } = makeAdapter();
    await adapter.replyTo(makeMessage({ phoneNumberId: 'NOPE' }), reply);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send when the formatted reply is empty', async () => {
    const { adapter, send } = makeAdapter({ buildForWhatsApp: vi.fn().mockReturnValue(null) });
    await adapter.replyTo(makeMessage({ phoneNumberId: 'PNID' }), reply);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('WhatsAppOutboundAdapter.sendProactive', () => {
  it('resolves the sender by (role, platformId), builds and sends', async () => {
    const { adapter, send } = makeAdapter();
    const result = await adapter.sendProactive(textDto);
    expect(result).toEqual({ messageId: 'wamid.123' });
    expect(send).toHaveBeenCalledWith({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      message: builtMessage,
    });
  });

  it('throws channel_not_configured when no phone resolves for (role, platformId)', async () => {
    vi.mocked(resolveWhatsAppPhoneByRole).mockReturnValue(null);
    const { adapter, send } = makeAdapter();
    await expect(adapter.sendProactive(textDto)).rejects.toMatchObject({
      name: 'IdpError',
      code: 'channel_not_configured',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('throws IdpError on internal channel-map inconsistency', async () => {
    vi.mocked(resolveWhatsAppByPhoneNumberId).mockReturnValue(null);
    const { adapter } = makeAdapter();
    await expect(adapter.sendProactive(textDto)).rejects.toBeInstanceOf(IdpError);
  });
});
