import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { Envelope } from '../../../src/clients/types/Envelope.js';
import type {
  ResolveIdentityOutput,
  ScheduleAppointmentResult,
  ToolExecuteResponse,
  ToolValidateResult,
} from '../../../src/clients/types/GuacucoTypes.js';
import { IdentityNotFoundError } from '../../../src/core/errors/IdentityNotFoundError.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
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
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
} as unknown as Logger;

afterEach(() => {
  vi.clearAllMocks();
});

describe('GuacucoClient.resolveIdentity', () => {
  it('returns the identity payload on happy path', async () => {
    const mockHttp = makeMockHttp();
    const identity: Partial<ResolveIdentityOutput> = {
      userUuid: 'usr-1',
      userName: 'Juan',
      profileType: 'client',
      isNewUser: false,
    };
    mockHttp.post.mockResolvedValue(makeResponse({ success: true, data: identity }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.resolveIdentity({
      channelType: 'whatsapp',
      channelId: '54911000000',
      phoneNumberId: 'pn-1',
    });

    expect(result.userUuid).toBe('usr-1');
    expect(mockHttp.post).toHaveBeenCalledWith('/identity/resolve', {
      channelType: 'whatsapp',
      channelId: '54911000000',
      phoneNumberId: 'pn-1',
      userName: undefined,
    });
  });

  it('translates USER_NOT_FOUND to IdentityNotFoundError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'silent skip' },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(
      client.resolveIdentity({ channelType: 'whatsapp', channelId: '54911000000' }),
    ).rejects.toBeInstanceOf(IdentityNotFoundError);
  });

  it('propagates other backend errors as ToolExecutionError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'INVALID_CHANNEL_TYPE', message: 'bad input' },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(
      client.resolveIdentity({ channelType: 'mars', channelId: 'x' }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe('GuacucoClient.executeTool', () => {
  it('posts the request body with tool_name and parameters', async () => {
    const mockHttp = makeMockHttp();
    const toolResponse: ToolExecuteResponse<ScheduleAppointmentResult> = {
      tool_name: 'schedule_appointment',
      result: {
        response_type: 'text',
        message: 'OK',
        appointment_uuid: 'apt-1',
        business_uuid: 'biz-1',
        client_uuid: 'cli-1',
        appointment_date: '2026-06-01',
        start_time: '10:00',
        end_time: '11:00',
        status: 1,
        staff_assignments: [],
      },
    };
    mockHttp.post.mockResolvedValue(makeResponse({ success: true, data: toolResponse }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.scheduleAppointment(
      {
        business_allia_id: 'allia-1',
        date: '2026-06-01',
        appointment_time: '10:00',
        client_uuid: 'cli-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
      },
      { idempotencyKey: 'idem-1' },
    );

    expect(result.appointment_uuid).toBe('apt-1');
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/tools/execute', {
      tool_name: 'schedule_appointment',
      parameters: {
        business_allia_id: 'allia-1',
        date: '2026-06-01',
        appointment_time: '10:00',
        client_uuid: 'cli-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
      },
      idempotency_key: 'idem-1',
    });
  });

  it('omits idempotency_key when not provided', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: {
          tool_name: 'cancel_appointment',
          result: { response_type: 'text', message: 'OK', appointment_uuid: 'apt-1', status: 2 },
        },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.cancelAppointment({ appointment_uuid: 'apt-1' });

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentBody.idempotency_key).toBeUndefined();
  });

  it('forwards context option when provided', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: {
          tool_name: 'confirm_appointment',
          result: { response_type: 'text', message: 'OK', appointment_uuid: 'apt-1', status: 3 },
        },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.confirmAppointment(
      { appointment_uuid: 'apt-1' },
      { context: { profile_uuid: 'p1' } },
    );

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentBody.context).toEqual({ profile_uuid: 'p1' });
  });

  it('propagates ToolExecutionError on backend failure', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'STAFF_NOT_AVAILABLE', message: 'slot taken' },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(
      client.scheduleAppointment({
        business_allia_id: 'allia-1',
        date: '2026-06-01',
        appointment_time: '10:00',
        client_uuid: 'cli-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
      }),
    ).rejects.toMatchObject({ code: 'STAFF_NOT_AVAILABLE' });
  });
});

describe('GuacucoClient.validateScheduleSlot', () => {
  it('sends date+time parameters and returns validate result', async () => {
    const mockHttp = makeMockHttp();
    const validateResult: ToolValidateResult = {
      valid: false,
      results: [
        { name: 'date', valid: true, message: null },
        { name: 'appointment_time', valid: false, message: 'taken' },
      ],
      suggestions: { appointment_time: ['10:00', '11:00', '14:00'] },
    };
    mockHttp.post.mockResolvedValue(makeResponse({ success: true, data: validateResult }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.validateScheduleSlot({
      date: '2026-06-01',
      appointment_time: '09:00',
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
    });

    expect(result.valid).toBe(false);
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/tools/validate', {
      tool_name: 'schedule_appointment',
      parameters: [
        { name: 'date', value: '2026-06-01' },
        { name: 'appointment_time', value: '09:00' },
      ],
      context: {
        business_allia_id: 'allia-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
      },
    });
  });

  it('omits parameters not provided', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: true, data: { valid: true, results: [] } }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.validateScheduleSlot({
      date: '2026-06-01',
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
    });

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as { parameters: unknown[] };
    expect(sentBody.parameters).toEqual([{ name: 'date', value: '2026-06-01' }]);
  });
});

describe('GuacucoClient.validateRescheduleSlot', () => {
  it('includes appointment_uuid in context for own-slot exclusion', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: true, data: { valid: true, results: [] } }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.validateRescheduleSlot({
      new_date: '2026-06-05',
      new_time: '14:00',
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
      appointment_uuid: 'apt-99',
    });

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as {
      tool_name: string;
      context: Record<string, unknown>;
    };
    expect(sentBody.tool_name).toBe('reschedule_appointment');
    expect(sentBody.context.appointment_uuid).toBe('apt-99');
  });
});

describe('GuacucoClient.checkAvailability', () => {
  it('calls execute with tool_name=check_availability', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: {
          tool_name: 'check_availability',
          result: {
            response_type: 'text',
            message: 'OK',
            suggestions: { schedule_appointment: [] },
          },
        },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.checkAvailability({
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
    });

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as { tool_name: string };
    expect(sentBody.tool_name).toBe('check_availability');
  });
});
