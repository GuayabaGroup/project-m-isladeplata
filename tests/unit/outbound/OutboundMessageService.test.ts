import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { WhatsAppSender } from '../../../src/channels/whatsapp/sender.js';
import { IdpError } from '../../../src/core/errors/IdpError.js';
import type { OutboundMessageDto } from '../../../src/core/types/OutboundMessage.js';
import type { DedupStore } from '../../../src/infrastructure/redis/DedupStore.js';
import type { OutboundMessageBuilder } from '../../../src/nlg/OutboundMessageBuilder.js';
import { OutboundMessageService } from '../../../src/outbound/OutboundMessageService.js';

vi.mock('../../../src/config/channels.config.js', () => ({
  resolveWhatsAppPhoneByRole: vi.fn(),
  resolveWhatsAppByPhoneNumberId: vi.fn(),
}));

import {
  resolveWhatsAppByPhoneNumberId,
  resolveWhatsAppPhoneByRole,
} from '../../../src/config/channels.config.js';

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

function makeService(overrides?: {
  build?: ReturnType<typeof vi.fn>;
  send?: ReturnType<typeof vi.fn>;
  isDuplicate?: ReturnType<typeof vi.fn>;
}) {
  const build = overrides?.build ?? vi.fn().mockReturnValue(builtMessage);
  const send = overrides?.send ?? vi.fn().mockResolvedValue('wamid.123');
  const isDuplicate = overrides?.isDuplicate ?? vi.fn().mockResolvedValue(false);
  const service = new OutboundMessageService({
    builder: { build } as unknown as OutboundMessageBuilder,
    sender: { send } as unknown as WhatsAppSender,
    dedup: { isDuplicate } as unknown as DedupStore,
    logger: mockLogger,
  });
  return { service, build, send, isDuplicate };
}

const textDto: OutboundMessageDto = {
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

describe('OutboundMessageService', () => {
  it('resolves channel, builds, sends and returns the Meta message id', async () => {
    const { service, send } = makeService();
    const result = await service.send(textDto);
    expect(result).toEqual({ messageId: 'wamid.123' });
    expect(send).toHaveBeenCalledWith({
      phoneNumberId: 'PNID',
      accessToken: 'tok',
      message: builtMessage,
    });
  });

  it('throws channel_not_configured when no phone resolves for (role, platformId)', async () => {
    vi.mocked(resolveWhatsAppPhoneByRole).mockReturnValue(null);
    const { service, send } = makeService();
    await expect(service.send(textDto)).rejects.toMatchObject({
      name: 'IdpError',
      code: 'channel_not_configured',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('short-circuits on duplicate idempotency key without sending', async () => {
    const isDuplicate = vi.fn().mockResolvedValue(true);
    const { service, send } = makeService({ isDuplicate });
    const result = await service.send({ ...textDto, idempotencyKey: 'k1' });
    expect(result).toEqual({ messageId: '' });
    expect(isDuplicate).toHaveBeenCalledWith('outbound', 'k1');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not consult dedup when no idempotency key', async () => {
    const { service, isDuplicate } = makeService();
    await service.send(textDto);
    expect(isDuplicate).not.toHaveBeenCalled();
  });

  it('surfaces IdpError instances unchanged', async () => {
    vi.mocked(resolveWhatsAppPhoneByRole).mockReturnValue(null);
    const { service } = makeService();
    await expect(service.send(textDto)).rejects.toBeInstanceOf(IdpError);
  });
});
