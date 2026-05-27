import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Identity } from '../../../src/core/types/Identity.js';
import type { CheckpointerService } from '../../../src/infrastructure/checkpointer/PostgresCheckpointerService.js';
import { ThreadResolver } from '../../../src/pregraph/ThreadResolver.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeCheckpointer(): CheckpointerService & {
  getCheckpointAge: ReturnType<typeof vi.fn>;
  deleteThread: ReturnType<typeof vi.fn>;
} {
  return {
    saver: {} as never,
    pool: {} as never,
    getCheckpointAge: vi.fn(),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'prof-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

afterEach(() => vi.clearAllMocks());

describe('ThreadResolver.buildThreadId', () => {
  it('builds the canonical thread_id', () => {
    const cp = makeCheckpointer();
    const r = new ThreadResolver(cp, mockLogger);
    expect(r.buildThreadId(IDENTITY)).toBe('biz-1:prof-1:whatsapp:1');
  });
});

describe('ThreadResolver.resolve', () => {
  it('returns fresh thread when checkpoint does not exist', async () => {
    const cp = makeCheckpointer();
    cp.getCheckpointAge.mockResolvedValue({ exists: false });
    const r = new ThreadResolver(cp, mockLogger);

    const result = await r.resolve(IDENTITY);
    expect(result.hasActiveCheckpoint).toBe(false);
    expect(result.wasExpired).toBe(false);
    expect(cp.deleteThread).not.toHaveBeenCalled();
  });

  it('returns active when checkpoint exists within TTL', async () => {
    const cp = makeCheckpointer();
    cp.getCheckpointAge.mockResolvedValue({ exists: true, ageMs: 1_000 });
    const r = new ThreadResolver(cp, mockLogger);

    const result = await r.resolve(IDENTITY);
    expect(result.hasActiveCheckpoint).toBe(true);
    expect(result.wasExpired).toBe(false);
    expect(cp.deleteThread).not.toHaveBeenCalled();
  });

  it('deletes thread and returns expired when past TTL', async () => {
    const cp = makeCheckpointer();
    // Default TTL is 86400s (24h); pass an age > that.
    cp.getCheckpointAge.mockResolvedValue({ exists: true, ageMs: 100_000_000 });
    const r = new ThreadResolver(cp, mockLogger);

    const result = await r.resolve(IDENTITY);
    expect(result.hasActiveCheckpoint).toBe(false);
    expect(result.wasExpired).toBe(true);
    expect(cp.deleteThread).toHaveBeenCalledWith('biz-1:prof-1:whatsapp:1');
  });

  it('still returns expired even if deleteThread throws', async () => {
    const cp = makeCheckpointer();
    cp.getCheckpointAge.mockResolvedValue({ exists: true, ageMs: 100_000_000 });
    cp.deleteThread.mockRejectedValue(new Error('boom'));
    const r = new ThreadResolver(cp, mockLogger);

    const result = await r.resolve(IDENTITY);
    expect(result.wasExpired).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
