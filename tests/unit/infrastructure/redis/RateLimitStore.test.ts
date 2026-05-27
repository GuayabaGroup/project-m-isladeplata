import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { RateLimitStore } from '../../../../src/infrastructure/redis/RateLimitStore.js';
import type { RedisClient } from '../../../../src/infrastructure/redis/RateLimitStore.js';

function makeMockRedis() {
  return { incr: vi.fn(), expire: vi.fn() };
}

const mockLogger = {
  warn: vi.fn(),
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

afterEach(() => vi.clearAllMocks());

const SCOPE = { tenantUuid: 'biz-1', profileUuid: 'prof-1', channel: 'whatsapp' };

describe('RateLimitStore.checkLimit', () => {
  it('sets TTL only on first hit', async () => {
    const redis = makeMockRedis();
    redis.incr.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    const store = new RateLimitStore(redis as unknown as RedisClient, mockLogger);

    await store.checkLimit(SCOPE);
    expect(redis.expire).toHaveBeenCalledWith('ratelimit:biz-1:prof-1:whatsapp', 60);

    redis.incr.mockResolvedValue(2);
    redis.expire.mockClear();
    await store.checkLimit(SCOPE);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('allows under the limit', async () => {
    const redis = makeMockRedis();
    redis.incr.mockResolvedValue(5);
    const store = new RateLimitStore(redis as unknown as RedisClient, mockLogger);

    const result = await store.checkLimit(SCOPE);
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(5);
    expect(result.remaining).toBe(15); // default RATE_LIMIT_MAX_PER_MINUTE = 20
  });

  it('denies past the limit and logs warn', async () => {
    const redis = makeMockRedis();
    redis.incr.mockResolvedValue(21);
    const store = new RateLimitStore(redis as unknown as RedisClient, mockLogger);

    const result = await store.checkLimit(SCOPE);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith('Rate limit hit', expect.objectContaining(SCOPE));
  });
});
