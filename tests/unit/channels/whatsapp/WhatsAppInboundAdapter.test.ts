import type { Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageProcessor } from '../../../../src/channels/ChannelAdapter.js';
import { createWhatsAppInboundAdapter } from '../../../../src/channels/whatsapp/WhatsAppInboundAdapter.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createWhatsAppInboundAdapter>[0];

const processor: MessageProcessor = { process: vi.fn().mockResolvedValue({ action: 'ignored' }) };

afterEach(() => vi.clearAllMocks());

describe('createWhatsAppInboundAdapter', () => {
  it('exposes channelType "whatsapp"', () => {
    expect(createWhatsAppInboundAdapter(mockLogger).channelType).toBe('whatsapp');
  });

  it('mounts GET + POST /webhooks/whatsapp (POST with a raw body parser)', () => {
    const get = vi.fn();
    const post = vi.fn();
    const app = { get, post } as unknown as Express;

    createWhatsAppInboundAdapter(mockLogger).register(app, processor);

    expect(get).toHaveBeenCalledWith('/webhooks/whatsapp', expect.any(Function));
    // POST receives (path, rawBodyParser, handler) — 3 args, middleware in the middle.
    const [path, mw, handler] = post.mock.calls[0];
    expect(path).toBe('/webhooks/whatsapp');
    expect(typeof mw).toBe('function');
    expect(typeof handler).toBe('function');
  });
});
