import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { MessageProcessor } from '../../../../src/channels/ChannelAdapter.js';
import { createWhatsAppWebhookHandler } from '../../../../src/channels/whatsapp/webhook.js';

// Importar el módulo de config solo para confirmar que el handler está expuesto.
// Los lookups vacíos (env JSON = '{}') hacen que el handler responda 403, lo
// cual nos sirve para verificar el branch sin necesidad de poblar el map.

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;
const mockProcessor: MessageProcessor = {
  process: vi.fn().mockResolvedValue({ action: 'response' }),
};

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

afterEach(() => vi.clearAllMocks());

describe('WhatsApp webhook — verify (GET)', () => {
  it('returns challenge on valid hub.mode + hub.verify_token', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const req = {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify-token',
        'hub.challenge': 'challenge-abc',
      },
    } as never;
    const res = makeRes();
    handler.verify(req, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('challenge-abc');
  });

  it('returns 403 on wrong verify token', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const req = {
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'WRONG',
        'hub.challenge': 'x',
      },
    } as never;
    const res = makeRes();
    handler.verify(req, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 on wrong hub.mode', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const req = {
      query: {
        'hub.mode': 'evil',
        'hub.verify_token': 'test-verify-token',
      },
    } as never;
    const res = makeRes();
    handler.verify(req, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('WhatsApp webhook — handle (POST)', () => {
  it('returns 200 immediately on empty body', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const req = { body: Buffer.alloc(0), headers: {} } as never;
    const res = makeRes();
    handler.handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 200 + ignore when payload has no phone_number_id (status events)', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: {} }] }] }));
    const req = { body, headers: {} } as never;
    const res = makeRes();
    handler.handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockProcessor.process).not.toHaveBeenCalled();
  });

  it('returns 403 when phone_number_id is unknown (no app secret)', () => {
    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const body = Buffer.from(
      JSON.stringify({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: 'unknown-pn' } } }] }],
      }),
    );
    const req = { body, headers: {} } as never;
    const res = makeRes();
    handler.handle(req, res as never);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockProcessor.process).not.toHaveBeenCalled();
  });
});
