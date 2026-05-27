import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import type { RedisClient } from './RedisConnection.js';

const KEY_PREFIX = 'ratelimit';
const WINDOW_SECONDS = 60;

export interface RateLimitScope {
  tenantUuid: string;
  profileUuid: string;
  channel: string;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  limit: number;
}

/**
 * Per-minute counter rate limit (INCR + EXPIRE on first hit).
 * Key format: `ratelimit:{tenantUuid}:{profileUuid}:{channel}`.
 *
 * Window is 60s — not a true sliding window but good enough for chat traffic.
 */
export class RateLimitStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly logger: Logger,
  ) {}

  async checkLimit(scope: RateLimitScope): Promise<RateLimitResult> {
    const key = `${KEY_PREFIX}:${scope.tenantUuid}:${scope.profileUuid}:${scope.channel}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, WINDOW_SECONDS);
    }
    const limit = env.RATE_LIMIT_MAX_PER_MINUTE;
    const allowed = count <= limit;
    if (!allowed) {
      this.logger.warn('Rate limit hit', { ...scope, count, limit });
    }
    return {
      allowed,
      count,
      remaining: Math.max(0, limit - count),
      limit,
    };
  }
}
