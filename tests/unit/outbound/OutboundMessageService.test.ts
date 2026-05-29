import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { IdpError } from '../../../src/core/errors/IdpError.js';
import type {
  OutboundChannelAdapter,
  OutboundChannelRegistry,
} from '../../../src/core/types/OutboundChannel.js';
import type { OutboundMessageDto } from '../../../src/core/types/OutboundMessage.js';
import type { DedupStore } from '../../../src/infrastructure/redis/DedupStore.js';
import { OutboundMessageService } from '../../../src/outbound/OutboundMessageService.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeService(overrides?: {
  sendProactive?: ReturnType<typeof vi.fn>;
  isDuplicate?: ReturnType<typeof vi.fn>;
  emptyRegistry?: boolean;
}) {
  const sendProactive =
    overrides?.sendProactive ?? vi.fn().mockResolvedValue({ messageId: 'wamid.123' });
  const isDuplicate = overrides?.isDuplicate ?? vi.fn().mockResolvedValue(false);
  const adapter = {
    channelType: 'whatsapp',
    replyTo: vi.fn(),
    sendProactive,
  } as unknown as OutboundChannelAdapter;
  const registry: OutboundChannelRegistry = overrides?.emptyRegistry
    ? new Map()
    : new Map([['whatsapp', adapter]]);
  const service = new OutboundMessageService({
    registry,
    dedup: { isDuplicate } as unknown as DedupStore,
    logger: mockLogger,
  });
  return { service, sendProactive, isDuplicate };
}

const textDto: OutboundMessageDto = {
  channelType: 'whatsapp',
  to: '549111',
  role: 'client',
  platformId: 1,
  type: 'text',
  text: { body: 'hi' },
};

afterEach(() => vi.clearAllMocks());

describe('OutboundMessageService', () => {
  it('resolves the adapter by channelType, delegates and returns the message id', async () => {
    const { service, sendProactive } = makeService();
    const result = await service.send(textDto);
    expect(result).toEqual({ messageId: 'wamid.123' });
    expect(sendProactive).toHaveBeenCalledWith(textDto);
  });

  it('throws channel_not_configured when no adapter is registered for the channelType', async () => {
    const { service, sendProactive } = makeService({ emptyRegistry: true });
    await expect(service.send(textDto)).rejects.toMatchObject({
      name: 'IdpError',
      code: 'channel_not_configured',
    });
    expect(sendProactive).not.toHaveBeenCalled();
  });

  it('short-circuits on duplicate idempotency key without sending', async () => {
    const isDuplicate = vi.fn().mockResolvedValue(true);
    const { service, sendProactive } = makeService({ isDuplicate });
    const result = await service.send({ ...textDto, idempotencyKey: 'k1' });
    expect(result).toEqual({ messageId: '' });
    expect(isDuplicate).toHaveBeenCalledWith('outbound', 'k1');
    expect(sendProactive).not.toHaveBeenCalled();
  });

  it('does not consult dedup when no idempotency key', async () => {
    const { service, isDuplicate } = makeService();
    await service.send(textDto);
    expect(isDuplicate).not.toHaveBeenCalled();
  });

  it('surfaces IdpError when the channel is not configured', async () => {
    const { service } = makeService({ emptyRegistry: true });
    await expect(service.send(textDto)).rejects.toBeInstanceOf(IdpError);
  });
});
