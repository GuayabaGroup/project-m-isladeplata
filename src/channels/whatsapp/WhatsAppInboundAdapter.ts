import express from 'express';
import type { Logger } from 'winston';
import type { InboundChannelAdapter, MessageProcessor } from '../ChannelAdapter.js';
import { createWhatsAppWebhookHandler } from './webhook.js';

/**
 * Adapter de entrada de WhatsApp. Monta `GET/POST /webhooks/whatsapp` con
 * `express.raw` POR RUTA (el HMAC necesita el Buffer crudo; `express.json`
 * global está prohibido — §13.1). Envuelve el webhook handler existente sin
 * modificarlo.
 */
export function createWhatsAppInboundAdapter(logger: Logger): InboundChannelAdapter {
  return {
    channelType: 'whatsapp',
    register(app, processor: MessageProcessor): void {
      const webhook = createWhatsAppWebhookHandler({ processor, logger });
      app.get('/webhooks/whatsapp', webhook.verify);
      app.post(
        '/webhooks/whatsapp',
        express.raw({ type: 'application/json', limit: '256kb' }),
        webhook.handle,
      );
    },
  };
}
