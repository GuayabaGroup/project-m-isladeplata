import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { WhatsAppSender } from '../../../../src/channels/whatsapp/sender.js';
import type { WhatsAppOutboundText } from '../../../../src/channels/whatsapp/types.js';
import type { RetryClient } from '../../../../src/infrastructure/http/RetryClient.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const message: WhatsAppOutboundText = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '549111',
  type: 'text',
  text: { body: 'hi' },
};

afterEach(() => vi.clearAllMocks());

describe('WhatsAppSender', () => {
  it('returns the Meta message id and posts to the versioned path with bearer auth', async () => {
    const post = vi.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.42' }] } });
    const sender = new WhatsAppSender({ post } as unknown as RetryClient, mockLogger);

    const id = await sender.send({ phoneNumberId: 'PNID', accessToken: 'tok', message });

    expect(id).toBe('wamid.42');
    expect(post).toHaveBeenCalledWith('/v22.0/PNID/messages', message, {
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('throws when Meta response has no message id', async () => {
    const post = vi.fn().mockResolvedValue({ data: { messages: [] } });
    const sender = new WhatsAppSender({ post } as unknown as RetryClient, mockLogger);

    await expect(
      sender.send({ phoneNumberId: 'PNID', accessToken: 'tok', message }),
    ).rejects.toMatchObject({ name: 'IdpError', code: 'whatsapp_no_message_id' });
  });

  it('translates a Meta/axios error into IdpError(whatsapp_send_failed) with details.meta', async () => {
    const axiosLike = Object.assign(new Error('Request failed with status 400'), {
      response: { status: 400, data: { error: { code: 132000, message: 'bad template' } } },
    });
    const post = vi.fn().mockRejectedValue(axiosLike);
    const sender = new WhatsAppSender({ post } as unknown as RetryClient, mockLogger);

    await expect(
      sender.send({ phoneNumberId: 'PNID', accessToken: 'tok', message }),
    ).rejects.toMatchObject({
      name: 'IdpError',
      code: 'whatsapp_send_failed',
      details: { meta: { code: 132000, message: 'bad template' } },
    });
  });
});
