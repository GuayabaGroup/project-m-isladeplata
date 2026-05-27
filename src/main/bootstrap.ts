import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { WhatsAppSender } from '../channels/whatsapp/sender.js';
import { createWhatsAppWebhookHandler } from '../channels/whatsapp/webhook.js';
import { GuacucoClient } from '../clients/GuacucoClient.js';
import { ParguitoClient } from '../clients/ParguitoClient.js';
import { env } from '../config/env.js';
import { RetryClient } from '../infrastructure/http/RetryClient.js';
import { errorHandler } from '../infrastructure/http/middleware/errorHandler.js';
import { registerRoutes } from '../infrastructure/http/registerRoutes.js';
import { logger } from '../infrastructure/observability/logger.js';
import { closeSentry, initSentry } from '../infrastructure/observability/sentry.js';
import { DedupStore } from '../infrastructure/redis/DedupStore.js';
import { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
import {
  type RedisClient,
  connectRedis,
  quitRedis,
} from '../infrastructure/redis/RedisConnection.js';
import { ResponseBuilder } from '../nlg/ResponseBuilder.js';
import { EchoResponder } from '../pregraph/EchoResponder.js';
import { ResponseDispatcher } from '../pregraph/ResponseDispatcher.js';
import { Pipeline } from '../pregraph/pipeline.js';

const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
const WHATSAPP_GRAPH_TIMEOUT_MS = 10_000;

export interface BootstrappedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

/**
 * Composition root. Orden estricto de inicialización (§3 REGLAS):
 *   1. env validado al import (Zod fail-fast)
 *   2. Sentry
 *   3. Redis
 *   4. HTTP clients (Guacuco, Parguito) + WhatsApp sender
 *   5. Redis stores
 *   6. NLG + dispatcher + responders
 *   7. Pipeline (MessageProcessor)
 *   8. Channel webhook handlers
 *   9. Express app + /health + registerRoutes + errorHandler
 *
 * Cleanup en orden inverso: Sentry → Redis. Cada paso captura sus errores.
 */
export async function bootstrap(): Promise<BootstrappedApp> {
  initSentry();
  const redis = await connectRedis(logger);

  const guacucoHttp = new RetryClient({
    baseURL: env.GUACUCO_URL,
    timeoutMs: env.GUACUCO_TIMEOUT_MS,
    headers: {
      'X-API-Key': env.GUACUCO_API_KEY,
      'Content-Type': 'application/json',
    },
    logger,
  });
  const guacuco = new GuacucoClient(guacucoHttp, logger);

  const parguitoHttp = new RetryClient({
    baseURL: env.PARGUITO_URL,
    timeoutMs: env.PARGUITO_TIMEOUT_MS,
    headers: {
      'X-API-Key': env.PARGUITO_API_KEY,
      'Content-Type': 'application/json',
    },
    logger,
  });
  const parguito = new ParguitoClient(parguitoHttp, logger);

  const dedup = new DedupStore(redis, logger);
  const rateLimit = new RateLimitStore(redis, logger);

  const whatsappHttp = new RetryClient({
    baseURL: WHATSAPP_GRAPH_BASE_URL,
    timeoutMs: WHATSAPP_GRAPH_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
    logger,
  });
  const whatsappSender = new WhatsAppSender(whatsappHttp, logger);

  const responseBuilder = new ResponseBuilder(logger);
  const dispatcher = new ResponseDispatcher(responseBuilder, whatsappSender, logger);
  const echoResponder = new EchoResponder();

  const pipeline = new Pipeline({
    dedup,
    rateLimit,
    guacuco,
    parguito,
    echoResponder,
    dispatcher,
    logger,
  });

  const whatsappWebhook = createWhatsAppWebhookHandler({ processor: pipeline, logger });

  const app = express();
  app.use(helmet());
  app.use(cors());

  app.get('/health', async (_req, res) => {
    let healthy = true;
    try {
      await redis.ping();
    } catch {
      healthy = false;
    }
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'degraded' });
  });

  registerRoutes(app, { whatsappWebhook });
  app.use(errorHandler);

  async function cleanup(): Promise<void> {
    await safeStep('close-sentry', () => closeSentry(2000));
    await safeStep('quit-redis', () => quitRedisSafely(redis));
  }

  return { app, cleanup };
}

async function safeStep(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn(`Cleanup step failed: ${label}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function quitRedisSafely(redis: RedisClient): Promise<void> {
  if (redis.isOpen) await quitRedis(redis);
}
