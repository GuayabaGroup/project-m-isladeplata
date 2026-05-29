import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createWhatsAppInboundAdapter } from '../channels/whatsapp/WhatsAppInboundAdapter.js';
import { createOutboundHttpHandler } from '../channels/whatsapp/outboundHttpHandler.js';
import { WhatsAppSender } from '../channels/whatsapp/sender.js';
import { GuacucoClient } from '../clients/GuacucoClient.js';
import { ParguitoClient } from '../clients/ParguitoClient.js';
import { env } from '../config/env.js';
import { compileGraph } from '../graph/compile.js';
import {
  type CheckpointerService,
  createCheckpointerService,
} from '../infrastructure/checkpointer/PostgresCheckpointerService.js';
import { RetryClient } from '../infrastructure/http/RetryClient.js';
import { createMetricsHandler } from '../infrastructure/http/metricsHandler.js';
import { errorHandler } from '../infrastructure/http/middleware/errorHandler.js';
import { registerRoutes } from '../infrastructure/http/registerRoutes.js';
import { createLlmProvider } from '../infrastructure/llm/createLlmProvider.js';
import { logger } from '../infrastructure/observability/logger.js';
import { metricsRegistry } from '../infrastructure/observability/metrics.js';
import { closeSentry, initSentry } from '../infrastructure/observability/sentry.js';
import { DedupStore } from '../infrastructure/redis/DedupStore.js';
import { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
import {
  type RedisClient,
  connectRedis,
  quitRedis,
} from '../infrastructure/redis/RedisConnection.js';
import { initLangSmith } from '../infrastructure/tracing/langsmith.js';
import { OutboundMessageBuilder } from '../nlg/OutboundMessageBuilder.js';
import { ResponseBuilder } from '../nlg/ResponseBuilder.js';
import { OutboundMessageService } from '../outbound/OutboundMessageService.js';
import { ConversationPersister } from '../pregraph/ConversationPersister.js';
import { ResponseDispatcher } from '../pregraph/ResponseDispatcher.js';
import { ThreadResolver } from '../pregraph/ThreadResolver.js';
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
 *   3. LangSmith tracing (opt-in)
 *   4. Redis
 *   5. Postgres checkpointer (LangGraph) + setup
 *   6. HTTP clients (Guacuco, Parguito) + WhatsApp sender
 *   7. Redis stores
 *   8. NLG + dispatcher
 *   9. ThreadResolver + Graph compile
 *   10. Pipeline (MessageProcessor)
 *   11. Channel webhook handlers
 *   12. Express app + /health + registerRoutes + errorHandler
 *
 * Cleanup en orden inverso: Sentry → Redis → Checkpointer Postgres.
 */
export async function bootstrap(): Promise<BootstrappedApp> {
  initSentry();
  initLangSmith();

  const redis = await connectRedis(logger);
  const checkpointer = await createCheckpointerService(logger);

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

  // Outbound S2S (Guacuco → IDP → WhatsApp). Reusa el `dedup` ya construido
  // para idempotencia opcional y el `whatsappSender` por inyección.
  const outboundBuilder = new OutboundMessageBuilder(responseBuilder);
  const outboundService = new OutboundMessageService({
    builder: outboundBuilder,
    sender: whatsappSender,
    dedup,
    logger,
  });
  const outboundMessagesHandler = createOutboundHttpHandler(outboundService, logger);

  const llm = createLlmProvider(env, logger);

  const threadResolver = new ThreadResolver(checkpointer, logger);
  const graph = compileGraph({ checkpointer: checkpointer.saver, logger, llm, guacuco });

  const persister = new ConversationPersister(guacuco, logger);

  const pipeline = new Pipeline({
    dedup,
    rateLimit,
    guacuco,
    parguito,
    threadResolver,
    graph,
    dispatcher,
    persister,
    logger,
  });

  const whatsappInbound = createWhatsAppInboundAdapter(logger);

  const app = express();
  app.use(helmet());
  app.use(cors());

  app.get('/health', async (_req, res) => {
    const checks = { redis: false, postgres: false };
    try {
      await redis.ping();
      checks.redis = true;
    } catch {
      // healthy stays false
    }
    try {
      await checkpointer.pool.query('SELECT 1');
      checks.postgres = true;
    } catch {
      // healthy stays false
    }
    const healthy = checks.redis && checks.postgres;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      checks,
    });
  });

  const metricsHandler = env.METRICS_API_KEY
    ? createMetricsHandler(metricsRegistry, env.METRICS_API_KEY)
    : undefined;
  if (!metricsHandler) {
    logger.info('Metrics endpoint disabled (METRICS_API_KEY empty)');
  }

  registerRoutes(app, {
    inboundChannels: [whatsappInbound],
    processor: pipeline,
    outboundMessagesHandler,
    ...(metricsHandler ? { metricsHandler } : {}),
  });
  app.use(errorHandler);

  async function cleanup(): Promise<void> {
    await safeStep('close-sentry', () => closeSentry(2000));
    await safeStep('quit-redis', () => quitRedisSafely(redis));
    await safeStep('checkpointer-shutdown', () => shutdownCheckpointer(checkpointer));
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

async function shutdownCheckpointer(checkpointer: CheckpointerService): Promise<void> {
  await checkpointer.shutdown();
}
