import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { DedupStore } from '../../../../src/infrastructure/redis/DedupStore.js';
import type { RedisClient } from '../../../../src/infrastructure/redis/RedisConnection.js';

function makeMockRedis() {
  return { set: vi.fn() };
}

const mockLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

afterEach(() => vi.clearAllMocks());

describe('DedupStore.isDuplicate', () => {
  it('returns false on first time (SET NX returns OK)', async () => {
    const redis = makeMockRedis();
    redis.set.mockResolvedValue('OK');
    const store = new DedupStore(redis as unknown as RedisClient, mockLogger);
    const result = await store.isDuplicate('whatsapp', 'wamid.1');
    expect(result).toBe(false);
    expect(redis.set).toHaveBeenCalledWith('dedup:whatsapp:wamid.1', '1', {
      NX: true,
      EX: expect.any(Number),
    });
  });

  it('returns true on duplicate (SET NX returns null)', async () => {
    const redis = makeMockRedis();
    redis.set.mockResolvedValue(null);
    const store = new DedupStore(redis as unknown as RedisClient, mockLogger);
    expect(await store.isDuplicate('whatsapp', 'wamid.1')).toBe(true);
  });

  it('namespaces keys by channel', async () => {
    const redis = makeMockRedis();
    redis.set.mockResolvedValue('OK');
    const store = new DedupStore(redis as unknown as RedisClient, mockLogger);
    await store.isDuplicate('telegram', 'update-1');
    expect(redis.set).toHaveBeenCalledWith(
      'dedup:telegram:update-1',
      '1',
      expect.objectContaining({ NX: true }),
    );
  });
});
