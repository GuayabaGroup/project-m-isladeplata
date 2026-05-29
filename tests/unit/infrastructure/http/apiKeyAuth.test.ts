import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiKeyAuth } from '../../../../src/infrastructure/http/middleware/apiKeyAuth.js';

const EXPECTED = 'super-secret-key-1234';

function makeReq(headerValue?: string): Request {
  return {
    path: '/api/v1/outbound/messages',
    header: vi.fn().mockReturnValue(headerValue),
  } as unknown as Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => vi.clearAllMocks());

describe('apiKeyAuth', () => {
  it('calls next() when the key matches', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    apiKeyAuth(EXPECTED)(makeReq(EXPECTED), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is wrong (same length)', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    apiKeyAuth(EXPECTED)(makeReq('wrong-secret-key-9999'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when the key is missing (length mismatch, no throw)', () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    expect(() => apiKeyAuth(EXPECTED)(makeReq(undefined), res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
