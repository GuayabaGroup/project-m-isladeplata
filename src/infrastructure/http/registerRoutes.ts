import express, { type Express, type RequestHandler } from 'express';
import type { WhatsAppWebhookHandler } from '../../channels/whatsapp/webhook.js';

export interface RouterDeps {
  whatsappWebhook: WhatsAppWebhookHandler;
  /** Si presente, se monta `/metrics` con auth via header X-Metrics-Key. */
  metricsHandler?: RequestHandler;
}

/**
 * Único punto de montaje de rutas. `bootstrap.ts` solo expone `/health`;
 * todo lo demás vive acá.
 *
 * Body parsers son POR RUTA, NUNCA globales (rompe HMAC del webhook WA
 * que necesita raw Buffer). Limit 256kb por defecto.
 */
export function registerRoutes(app: Express, deps: RouterDeps): void {
  app.get('/webhooks/whatsapp', deps.whatsappWebhook.verify);
  app.post(
    '/webhooks/whatsapp',
    express.raw({ type: 'application/json', limit: '256kb' }),
    deps.whatsappWebhook.handle,
  );
  if (deps.metricsHandler) {
    app.get('/metrics', deps.metricsHandler);
  }
}
