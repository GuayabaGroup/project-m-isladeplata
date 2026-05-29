import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdpError } from '../../../../src/core/errors/IdpError.js';
import type { OutboundSender } from '../../../../src/core/types/OutboundMessage.js';
import { createOutboundHttpHandler } from '../../../../src/infrastructure/http/outboundHttpHandler.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createOutboundHttpHandler>[1];

function makeReq(body: unknown): Request {
  return { body } as Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

const validBody = {
  to: '549111',
  user_type: 'client',
  platform_id: 1,
  type: 'text',
  text: { body: 'hola' },
};

afterEach(() => vi.clearAllMocks());

describe('createOutboundHttpHandler', () => {
  it('returns 400 with invalid_request on a malformed body', async () => {
    const sender: OutboundSender = { send: vi.fn() };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq({ type: 'nope' }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'invalid_request' }),
      }),
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('returns 200 with the message id on success', async () => {
    const sender: OutboundSender = { send: vi.fn().mockResolvedValue({ messageId: 'wamid.9' }) };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq(validBody), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { messageId: 'wamid.9' } });
  });

  it('maps a plain IdpError (no upstreamDeliveryFailure) to 400', async () => {
    const sender: OutboundSender = {
      send: vi.fn().mockRejectedValue(new IdpError('channel_not_configured', 'no channel')),
    };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq(validBody), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'channel_not_configured' }),
      }),
    );
  });

  it('maps an upstreamDeliveryFailure IdpError to 502 preserving error.details', async () => {
    const sender: OutboundSender = {
      send: vi.fn().mockRejectedValue(
        new IdpError(
          'whatsapp_send_failed',
          'boom',
          { meta: { code: 132000 } },
          {
            upstreamDeliveryFailure: true,
          },
        ),
      ),
    };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq(validBody), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'whatsapp_send_failed',
          details: { meta: { code: 132000 } },
        }),
      }),
    );
  });

  it('maps an upstreamDeliveryFailure with a non-whatsapp code to 502 (channel-agnostic)', async () => {
    const sender: OutboundSender = {
      send: vi.fn().mockRejectedValue(
        new IdpError('telegram_send_failed', 'down', undefined, {
          upstreamDeliveryFailure: true,
        }),
      ),
    };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq(validBody), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it('maps an unexpected (non-IdpError) error to 500', async () => {
    const sender: OutboundSender = { send: vi.fn().mockRejectedValue(new Error('kaboom')) };
    const res = makeRes();
    await createOutboundHttpHandler(sender, mockLogger)(makeReq(validBody), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
