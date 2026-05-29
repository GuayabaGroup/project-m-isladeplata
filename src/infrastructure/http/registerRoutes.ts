import express, { type Express, type RequestHandler } from 'express';
import type { InboundChannelAdapter, MessageProcessor } from '../../channels/ChannelAdapter.js';
import { env } from '../../config/env.js';
import { apiKeyAuth } from './middleware/apiKeyAuth.js';

export interface RouterDeps {
  /** Canales de entrada; cada uno monta sus propias rutas (y body-parser). */
  inboundChannels: InboundChannelAdapter[];
  /** Pipeline pre-grafo al que los canales entregan mensajes normalizados. */
  processor: MessageProcessor;
  /** Handler S2S de envío de mensajes (`POST /api/v1/outbound/messages`). */
  outboundMessagesHandler: RequestHandler;
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
  // Canales de entrada (cada adapter monta sus rutas + body-parser propio).
  for (const channel of deps.inboundChannels) {
    channel.register(app, deps.processor);
  }

  // S2S outbound: Guacuco → IDP. `express.json` POR RUTA (global rompe el HMAC
  // del webhook). Auth por API key timing-safe antes de parsear el body.
  app.post(
    '/api/v1/outbound/messages',
    apiKeyAuth(env.IDP_API_KEY),
    express.json({ limit: '256kb' }),
    deps.outboundMessagesHandler,
  );

  if (deps.metricsHandler) {
    app.get('/metrics', deps.metricsHandler);
  }
}
