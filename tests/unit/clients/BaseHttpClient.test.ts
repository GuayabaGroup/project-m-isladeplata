import type { AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'winston';
import { BaseHttpClient } from '../../../src/clients/BaseHttpClient.js';
import type { Envelope } from '../../../src/clients/types/Envelope.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
import type { RetryClient } from '../../../src/infrastructure/http/RetryClient.js';

class TestClient extends BaseHttpClient {
  protected readonly errorPrefix = 'test';

  publicUnwrap<T>(response: AxiosResponse<Envelope<T>>): T {
    return this.unwrap(response);
  }
}

function makeResponse<T>(data: Envelope<T>, status = 200): AxiosResponse<Envelope<T>> {
  return {
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

const mockHttp = {} as RetryClient;
const mockLogger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
} as unknown as Logger;

describe('BaseHttpClient.unwrap', () => {
  const client = new TestClient(mockHttp, mockLogger);

  it('returns data on success envelope', () => {
    const response = makeResponse<{ id: string }>({ success: true, data: { id: 'abc' } });
    expect(client.publicUnwrap(response)).toEqual({ id: 'abc' });
  });

  it('throws ToolExecutionError with backend code on success=false', () => {
    const response = makeResponse<unknown>({
      success: false,
      error: { code: 'STAFF_NOT_AVAILABLE', message: 'taken', details: { slot: '10:00' } },
    });
    expect(() => client.publicUnwrap(response)).toThrowError(ToolExecutionError);
    try {
      client.publicUnwrap(response);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
      const e = err as ToolExecutionError;
      expect(e.code).toBe('STAFF_NOT_AVAILABLE');
      expect(e.message).toBe('taken');
      expect(e.details).toEqual({ slot: '10:00' });
    }
  });

  it('falls back to {prefix}_unknown_error when error envelope has no code', () => {
    const response = makeResponse<unknown>({ success: false });
    try {
      client.publicUnwrap(response);
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe('test_unknown_error');
    }
  });

  it('throws {prefix}_missing_data on success=true with no data', () => {
    const response = makeResponse<unknown>({ success: true });
    try {
      client.publicUnwrap(response);
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe('test_missing_data');
    }
  });

  it('throws {prefix}_invalid_envelope when body is null', () => {
    const response = {
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    } as unknown as AxiosResponse<Envelope<unknown>>;
    try {
      client.publicUnwrap(response);
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe('test_invalid_envelope');
    }
  });

  it('throws {prefix}_invalid_envelope when success is missing', () => {
    const response = {
      data: { foo: 'bar' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    } as unknown as AxiosResponse<Envelope<unknown>>;
    try {
      client.publicUnwrap(response);
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe('test_invalid_envelope');
    }
  });

  it('throws {prefix}_invalid_envelope when success is not boolean', () => {
    const response = {
      data: { success: 'yes' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    } as unknown as AxiosResponse<Envelope<unknown>>;
    try {
      client.publicUnwrap(response);
    } catch (err) {
      const e = err as ToolExecutionError;
      expect(e.code).toBe('test_invalid_envelope');
    }
  });

  it('preserves data when it is a falsy primitive (0, "", false)', () => {
    expect(client.publicUnwrap(makeResponse<number>({ success: true, data: 0 }))).toBe(0);
    expect(client.publicUnwrap(makeResponse<string>({ success: true, data: '' }))).toBe('');
    expect(client.publicUnwrap(makeResponse<boolean>({ success: true, data: false }))).toBe(false);
  });
});
