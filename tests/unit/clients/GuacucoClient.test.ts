import type { AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { Envelope } from '../../../src/clients/types/Envelope.js';
import type {
  CheckAvailabilityResult,
  ResolveIdentityOutput,
  ScheduleAppointmentResult,
  ToolExecuteResponse,
  ValidateRescheduleSlotResult,
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

describe('GuacucoClient.validateRescheduleSlot', () => {
  it('calls executeTool with tool_name=validate_reschedule_slot and legacy shape', async () => {
    const mockHttp = makeMockHttp();
    const validateResult: ValidateRescheduleSlotResult = {
      passed: true,
      proposed_slots: [{ date: '2026-06-05', time: '14:00' }],
      appointment_uuid: 'apt-99',
      service_duration_minutes: 60,
    };
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: { tool_name: 'validate_reschedule_slot', result: validateResult },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.validateRescheduleSlot({
      appointment_uuid: 'apt-99',
      profile_uuid: 'cli-1',
      date_hint: ['2026-06-05'],
      time_hint: '14:00',
    });

    expect(result.passed).toBe(true);
    expect(result.proposed_slots).toEqual([{ date: '2026-06-05', time: '14:00' }]);
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/tools/execute', {
      tool_name: 'validate_reschedule_slot',
      parameters: {
        appointment_uuid: 'apt-99',
        profile_uuid: 'cli-1',
        date_hint: ['2026-06-05'],
        time_hint: '14:00',
      },
    });
  });

  it('returns passed=false with proposed_slots when exact slot unavailable', async () => {
    const mockHttp = makeMockHttp();
    const validateResult: ValidateRescheduleSlotResult = {
      passed: false,
      proposed_slots: [
        { date: '2026-06-05', time: '15:00' },
        { date: '2026-06-05', time: '16:00' },
      ],
      appointment_uuid: 'apt-99',
      service_duration_minutes: 60,
      fallback: {
        kind: 'selection_list',
        slot_name: 'reschedule_slot',
        header: 'Horarios disponibles:',
        button_text: 'Elegir horario',
        options: [{ id: '2026-06-05|15:00', title: '5 jun 15:00', description: '5 junio 15:00' }],
      },
    };
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: { tool_name: 'validate_reschedule_slot', result: validateResult },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.validateRescheduleSlot({
      appointment_uuid: 'apt-99',
      profile_uuid: 'cli-1',
      date_hint: ['2026-06-05'],
      time_hint: '14:00',
    });

    expect(result.passed).toBe(false);
    expect(result.proposed_slots).toHaveLength(2);
    expect(result.fallback?.kind).toBe('selection_list');
  });
});

describe('GuacucoClient.getStaffAppointmentsSummary', () => {
  it('calls executeTool with profile/business uuids in context', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: {
          tool_name: 'get_staff_appointments_summary',
          result: {
            response_type: 'text',
            message: 'ok',
            summary: 'Hoy: 0 turnos',
            total: 0,
            date_start: '2026-05-28',
            date_end: '2026-05-28',
            appointments: [],
          },
        },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.getStaffAppointmentsSummary(
      { date_start: '2026-05-28', date_end: '2026-05-28' },
      { profileUuid: 'staff-uuid', businessUuid: 'biz-uuid' },
    );
    expect(result.total).toBe(0);
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/tools/execute', {
      tool_name: 'get_staff_appointments_summary',
      parameters: { date_start: '2026-05-28', date_end: '2026-05-28' },
      context: {
        profile_uuid: 'staff-uuid',
        business_uuid: 'biz-uuid',
        profile_type: 'staff',
      },
    });
  });
});

describe('GuacucoClient.query-processor', () => {
  it('getQueryTables: GET con profile_type + role_id en params', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: true,
        data: [
          {
            table_name: 'front_sche_client.services',
            table_comment: 'Services catalog',
            columns: [
              { column_name: 'service_uuid', column_comment: null },
              { column_name: 'service_name', column_comment: 'Display name' },
            ],
          },
        ],
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.getQueryTables('staff', 1);
    expect(result).toHaveLength(1);
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/query-processor/tables', {
      params: { profile_type: 'staff', role_id: 1 },
    });
  });

  it('getQueryTables: client role omits role_id', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(makeResponse({ success: true, data: [] }));
    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.getQueryTables('client');
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/query-processor/tables', {
      params: { profile_type: 'client' },
    });
  });

  it('getQueryTableSchema: encodes table name + sends params', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: true,
        data: { columns: [], foreignKeys: [] },
      }),
    );
    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.getQueryTableSchema('services', 'staff', 2);
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/query-processor/tables/services/schema', {
      params: { profile_type: 'staff', role_id: 2 },
    });
  });

  it('executeQuery: POST con sql + profile_type + role_id (stringified)', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: { rows: [{ count: 5 }], rowCount: 1 },
      }),
    );
    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.executeQuery('SELECT count(*) FROM services', 'staff', 1, 5000);
    expect(result.rows).toEqual([{ count: 5 }]);
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/query-processor/query', {
      sql: 'SELECT count(*) FROM services',
      profile_type: 'staff',
      role_id: '1',
      timeout: 5000,
    });
  });

  it('executeQuery: client role omits role_id', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: true, data: { rows: [], rowCount: 0 } }),
    );
    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.executeQuery('SELECT 1', 'client');
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/query-processor/query', {
      sql: 'SELECT 1',
      profile_type: 'client',
    });
  });

  it('executeQuery: propagates ToolExecutionError on Guacuco rejection', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'DANGEROUS_KEYWORD_DETECTED', message: 'DROP not allowed' },
      }),
    );
    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(client.executeQuery('DROP TABLE x', 'staff', 1)).rejects.toMatchObject({
      code: 'DANGEROUS_KEYWORD_DETECTED',
    });
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

  it('returns available=true + empty suggestions in Mode A on hit', async () => {
    const mockHttp = makeMockHttp();
    const availResult: CheckAvailabilityResult = {
      response_type: 'text',
      message: 'available',
      available: true,
      date: '2026-06-01',
      start_time: '10:00',
      end_time: '11:00',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
      total_duration_minutes: 60,
      suggestions: { schedule_appointment: [] },
    };
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: true,
        data: { tool_name: 'check_availability', result: availResult },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.checkAvailability({
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-1',
      service_uuids: ['svc-1'],
      date: '2026-06-01',
      appointment_time: '10:00',
    });

    expect(result.available).toBe(true);
  });
});
