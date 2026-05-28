import { type RedisClientType, createClient } from 'redis';
import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import { IdpError } from '../../core/errors/IdpError.js';

export type RedisClient = RedisClientType;

/**
 * Connect to Redis. Fails fast with `IdpError('redis_connect_failed')` on
 * initial connect failure — the agent cannot run without Redis (dedup +
 * rate limit live here).
 *
 * Subsequent reconnects are handled internally by `redis@4` driver; the
 * `error` listener logs them as warn (cliente conserva queue + reconecta).
 */
export async function connectRedis(logger: Logger): Promise<RedisClient> {
  const client = createClient({ url: env.REDIS_URL });
  client.on('error', (err: unknown) => {
    logger.warn('Redis client error', { error: describeError(err), url: env.REDIS_URL });
  });
  client.on('connect', () => {
    logger.info('Redis client connected');
  });
  try {
    await client.connect();
  } catch (err) {
    throw new IdpError('redis_connect_failed', `Could not connect to Redis at ${env.REDIS_URL}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return client as RedisClient;
}

export async function quitRedis(client: RedisClient): Promise<void> {
  await client.quit();
}

/**
 * `node-redis` a veces emite `AggregateError` con `.message` vacío. El
 * detalle de la falla vive en `.errors[]`. Esta helper destila ambos casos a
 * un string útil para logs.
 */
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors
      .map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)))
      .filter((s) => s.length > 0);
    return inner.length > 0 ? inner.join('; ') : 'AggregateError (no inner messages)';
  }
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  return String(err);
}
