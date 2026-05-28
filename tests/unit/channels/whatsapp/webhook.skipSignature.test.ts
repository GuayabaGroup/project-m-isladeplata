import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { MessageProcessor } from '../../../../src/channels/ChannelAdapter.js';

/**
 * Tests del dev-only `WHATSAPP_SKIP_SIGNATURE=true`. Necesita reset de módulos
 * porque `env.ts` parsea `process.env` al import-time y el handler captura
 * `env.WHATSAPP_SKIP_SIGNATURE` desde ahí.
 */

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

describe('WhatsApp webhook — WHATSAPP_SKIP_SIGNATURE=true (dev path)', () => {
  let prevSkip: string | undefined;
  let prevMap: string | undefined;

  beforeEach(() => {
    prevSkip = process.env.WHATSAPP_SKIP_SIGNATURE;
    prevMap = process.env.WHATSAPP_CHANNEL_MAP_JSON;
    process.env.WHATSAPP_SKIP_SIGNATURE = 'true';
    process.env.WHATSAPP_CHANNEL_MAP_JSON = JSON.stringify({
      '111': { access_token: 'tok', role: 'client', platform_id: 1 },
    });
    vi.resetModules();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: `delete` es la forma correcta de quitar una env var (asignar undefined la setea como string "undefined").
    if (prevSkip === undefined) delete process.env.WHATSAPP_SKIP_SIGNATURE;
    else process.env.WHATSAPP_SKIP_SIGNATURE = prevSkip;
    // biome-ignore lint/performance/noDelete: idem.
    if (prevMap === undefined) delete process.env.WHATSAPP_CHANNEL_MAP_JSON;
    else process.env.WHATSAPP_CHANNEL_MAP_JSON = prevMap;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('responds 200 without validating HMAC when phone_number_id is known', async () => {
    const { createWhatsAppWebhookHandler } = await import(
      '../../../../src/channels/whatsapp/webhook.js'
    );

    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const body = Buffer.from(
      JSON.stringify({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' } } }] }],
      }),
    );
    const req = { body, headers: {} } as never; // no x-hub-signature-256 header
    const res = makeRes();

    handler.handle(req, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    // El log warn se emite cada request en modo skip — debe verse.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SKIPPED'),
      expect.objectContaining({ phoneNumberId: '111' }),
    );
  });

  it('still rejects unknown phone_number_id with 403 (skip does NOT bypass identity)', async () => {
    const { createWhatsAppWebhookHandler } = await import(
      '../../../../src/channels/whatsapp/webhook.js'
    );

    const handler = createWhatsAppWebhookHandler({ processor: mockProcessor, logger: mockLogger });
    const body = Buffer.from(
      JSON.stringify({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: 'unknown' } } }] }],
      }),
    );
    const req = { body, headers: {} } as never;
    const res = makeRes();

    handler.handle(req, res as never);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockProcessor.process).not.toHaveBeenCalled();
  });
});
