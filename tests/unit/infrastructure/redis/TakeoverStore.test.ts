import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { RedisClient } from '../../../../src/infrastructure/redis/RedisConnection.js';
import { TakeoverStore } from '../../../../src/infrastructure/redis/TakeoverStore.js';

function makeMockRedis() {
  return {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn(),
    expire: vi.fn().mockResolvedValue(1),
  };
}

const mockLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const THREAD = 'biz-1:cli-1:whatsapp:1';

afterEach(() => vi.clearAllMocks());

describe('TakeoverStore', () => {
  it('isHumanControlled returns true when the mirror key exists', async () => {
    const redis = makeMockRedis();
    redis.get.mockResolvedValue('1');
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);
    expect(await store.isHumanControlled(THREAD)).toBe(true);
    expect(redis.get).toHaveBeenCalledWith(`takeover:active:${THREAD}`);
  });

  it('isHumanControlled returns false when the mirror key is absent', async () => {
    const redis = makeMockRedis();
    redis.get.mockResolvedValue(null);
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);
    expect(await store.isHumanControlled(THREAD)).toBe(false);
  });

  it('mirrorActive sets the key with an explicit TTL', async () => {
    const redis = makeMockRedis();
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);
    await store.mirrorActive(THREAD);
    expect(redis.set).toHaveBeenCalledWith(`takeover:active:${THREAD}`, '1', {
      EX: expect.any(Number),
    });
  });

  it('clear deletes the mirror key', async () => {
    const redis = makeMockRedis();
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);
    await store.clear(THREAD);
    expect(redis.del).toHaveBeenCalledWith(`takeover:active:${THREAD}`);
  });

  it('bumpFailures increments and sets TTL only on the first increment', async () => {
    const redis = makeMockRedis();
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);

    expect(await store.bumpFailures(THREAD)).toBe(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith(`takeover:fails:${THREAD}`, expect.any(Number));

    expect(await store.bumpFailures(THREAD)).toBe(2);
    // No vuelve a setear TTL en incrementos subsiguientes.
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('resetFailures deletes the counter key', async () => {
    const redis = makeMockRedis();
    const store = new TakeoverStore(redis as unknown as RedisClient, mockLogger);
    await store.resetFailures(THREAD);
    expect(redis.del).toHaveBeenCalledWith(`takeover:fails:${THREAD}`);
  });
});
