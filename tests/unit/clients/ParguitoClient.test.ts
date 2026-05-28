import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { ParguitoClient } from '../../../src/clients/ParguitoClient.js';
import type { Envelope } from '../../../src/clients/types/Envelope.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
import type { CrmContext } from '../../../src/core/types/CrmContext.js';
import type { RetryClient } from '../../../src/infrastructure/http/RetryClient.js';

function makeResponse<T>(data: Envelope<T>, status = 200): AxiosResponse<Envelope<T>> {
  return {
    data,
    status,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

function makeMockHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
  };
}

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

afterEach(() => {
  vi.clearAllMocks();
});

describe('ParguitoClient.getCrmContext', () => {
  it('returns the CRM context on happy path', async () => {
    const mockHttp = makeMockHttp();
    const crm: CrmContext = {
      upcomingAppointments: [
        {
          appointmentUuid: 'apt-1',
          description: 'corte mañana 16:00',
          startAt: '2026-05-28T19:00:00Z',
        },
      ],
      profileMeta: { tag: 'vip' },
    };
    mockHttp.get.mockResolvedValue(makeResponse({ success: true, data: crm }));

    const client = new ParguitoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.getCrmContext('prof-1');

    expect(result).toEqual(crm);
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/crm/context/prof-1');
  });

  it('throws ToolExecutionError when backend returns success=false', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({ success: false, error: { code: 'PROFILE_NOT_FOUND', message: 'nope' } }),
    );

    const client = new ParguitoClient(mockHttp as unknown as RetryClient, mockLogger);

    await expect(client.getCrmContext('prof-1')).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(client.getCrmContext('prof-1')).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });

  it('propagates http errors (network failure)', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new ParguitoClient(mockHttp as unknown as RetryClient, mockLogger);

    await expect(client.getCrmContext('prof-1')).rejects.toThrow('ECONNREFUSED');
  });

  it('throws parguito_invalid_envelope on malformed response', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(makeResponse({ foo: 'bar' } as unknown as Envelope<CrmContext>));

    const client = new ParguitoClient(mockHttp as unknown as RetryClient, mockLogger);

    await expect(client.getCrmContext('prof-1')).rejects.toMatchObject({
      code: 'parguito_invalid_envelope',
    });
  });
});
