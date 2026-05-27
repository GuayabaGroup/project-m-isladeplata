import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import type { RedisClient } from './RedisConnection.js';

const KEY_PREFIX = 'dedup';

/**
 * Idempotency dedup for inbound channel messages. `SET NX` + TTL.
 * Key format: `dedup:{channelType}:{messageId}`.
 *
 * Per REGLAS_ISLADEPLATA §10: TTL siempre explícito, `SCAN` no `KEYS`.
 */
export class DedupStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Returns `true` if this `messageId` was already seen within the TTL window.
   * Returns `false` if first time (and registers it atomically).
   */
  async isDuplicate(channelType: string, messageId: string): Promise<boolean> {
    const key = `${KEY_PREFIX}:${channelType}:${messageId}`;
    const result = await this.redis.set(key, '1', {
      NX: true,
      EX: env.DEDUP_TTL_SECONDS,
    });
    if (result === null) {
      this.logger.debug('Duplicate message detected', { channelType, messageId });
      return true;
    }
    return false;
  }
}
