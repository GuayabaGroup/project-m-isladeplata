import { AxiosError, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { Envelope } from '../../../src/clients/types/Envelope.js';
import type {
  CheckAvailabilityResult,
  IdentityResolveRawResponse,
  PersistAgentTurnsRequest,
  PersistAgentTurnsResponse,
  ScheduleAppointmentResult,
  ToolExecuteResponse,
  TriggerTakeoverRequest,
  ValidateRescheduleSlotResult,
} from '../../../src/clients/types/GuacucoTypes.js';
import { IdentityNotFoundError } from '../../../src/core/errors/IdentityNotFoundError.js';
import { ToolExecutionError } from '../../../src/core/errors/ToolExecutionError.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import type { RetryClient } from '../../../src/infrastructure/http/RetryClient.js';

/** Identity de cliente — el context uniforme se deriva de acá. */
const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'cli-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

/** context uniforme esperado para IDENTITY_CLIENT (sin role_id). */
const CONTEXT_CLIENT = {
  profile_uuid: 'cli-1',
  profile_type: 'client',
  business_uuid: 'biz-1',
};

const IDENTITY_STAFF: Identity = {
  tenantUuid: 'biz-uuid',
  tenantAlliaId: 'allia-1',
  profileUuid: 'staff-uuid',
  profileType: 'staff',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

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
  const makeRaw = (
    overrides: Partial<IdentityResolveRawResponse> = {},
  ): IdentityResolveRawResponse => ({
    user_uuid: 'usr-1',
    user_name: 'Juan',
    user_phone: '+54911000000',
    user_timezone: 'America/Argentina/Buenos_Aires',
    user_language: 'es',
    profile_type: 'client',
    profile_data: { client_uuid: 'cli-1' },
    preferences: { working_hours: null },
    business_staff_roles: null,
    helpers_lists: null,
    channel_data: null,
    is_new_user: false,
    ...overrides,
  });

  it('GET /api/v1/identity/resolve with snake_case query params + maps raw → camelCase', async () => {
    const mockHttp = makeMockHttp();
    const raw = makeRaw({
      is_new_user: true,
      welcome_message: 'Hola',
      onboarding_url: 'https://x',
    });
    mockHttp.get.mockResolvedValue(makeResponse({ success: true, data: raw }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.resolveIdentity({
      channelType: 'whatsapp',
      channelId: '54911000000',
      phoneNumberId: 'pn-1',
      userName: 'Juan',
    });

    expect(result.userUuid).toBe('usr-1');
    expect(result.userName).toBe('Juan');
    expect(result.profileType).toBe('client');
    expect(result.isNewUser).toBe(true);
    expect(result.welcomeMessage).toBe('Hola');
    expect(result.onboardingUrl).toBe('https://x');
    expect(result.helpersLists).toEqual([]);
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/identity/resolve', {
      params: {
        channel_type: 'whatsapp',
        channel_id: '54911000000',
        phone_number_id: 'pn-1',
        user_name: 'Juan',
      },
    });
  });

  it('omits phone_number_id + user_name when not provided', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(makeResponse({ success: true, data: makeRaw() }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.resolveIdentity({ channelType: 'mobile', channelId: 'profile-uuid' });

    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/identity/resolve', {
      params: { channel_type: 'mobile', channel_id: 'profile-uuid' },
    });
  });

  it('translates envelope USER_NOT_FOUND to IdentityNotFoundError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
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

  it('translates axios 404 to IdentityNotFoundError', async () => {
    const mockHttp = makeMockHttp();
    const axiosErr = new AxiosError('Request failed with status code 404');
    axiosErr.response = { status: 404 } as AxiosError['response'];
    mockHttp.get.mockRejectedValue(axiosErr);

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(
      client.resolveIdentity({ channelType: 'whatsapp', channelId: '54911000000' }),
    ).rejects.toBeInstanceOf(IdentityNotFoundError);
  });

  it('propagates other backend envelope errors as ToolExecutionError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
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

  it('wraps non-404 axios errors as ToolExecutionError(guacuco_identity_error)', async () => {
    const mockHttp = makeMockHttp();
    const axiosErr = new AxiosError('Request failed with status code 500');
    axiosErr.response = { status: 500 } as AxiosError['response'];
    mockHttp.get.mockRejectedValue(axiosErr);

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(
      client.resolveIdentity({ channelType: 'whatsapp', channelId: 'x' }),
    ).rejects.toMatchObject({ code: 'guacuco_identity_error' });
  });

  it('maps human_controlled when present (spec P-human-takeover)', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: true,
        data: makeRaw({ human_controlled: { active: true, expires_at: '2026-05-28T18:00:00Z' } }),
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.resolveIdentity({ channelType: 'whatsapp', channelId: 'x' });

    expect(result.humanControlled).toEqual({ active: true, expiresAt: '2026-05-28T18:00:00Z' });
  });

  it('leaves humanControlled undefined when Guacuco omits the field', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(makeResponse({ success: true, data: makeRaw() }));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.resolveIdentity({ channelType: 'whatsapp', channelId: 'x' });

    expect(result.humanControlled).toBeUndefined();
  });
});

describe('GuacucoClient tool dispatch (context uniforme)', () => {
  it('posts the request body with tool_name, parameters and uniform context', async () => {
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
      IDENTITY_CLIENT,
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
      context: CONTEXT_CLIENT,
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
    await client.cancelAppointment({ appointment_uuid: 'apt-1' }, IDENTITY_CLIENT);

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentBody.idempotency_key).toBeUndefined();
  });

  it('derives the uniform context from identity (callers never pass context)', async () => {
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
    await client.confirmAppointment({ appointment_uuid: 'apt-1' }, IDENTITY_CLIENT);

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sentBody.context).toEqual(CONTEXT_CLIENT);
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
      client.scheduleAppointment(
        {
          business_allia_id: 'allia-1',
          date: '2026-06-01',
          appointment_time: '10:00',
          client_uuid: 'cli-1',
          staff_uuid: 'stf-1',
          service_uuids: ['svc-1'],
        },
        IDENTITY_CLIENT,
      ),
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
    const result = await client.validateRescheduleSlot(
      {
        appointment_uuid: 'apt-99',
        profile_uuid: 'cli-1',
        date_hint: ['2026-06-05'],
        time_hint: '14:00',
      },
      IDENTITY_CLIENT,
    );

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
      context: CONTEXT_CLIENT,
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
    const result = await client.validateRescheduleSlot(
      {
        appointment_uuid: 'apt-99',
        profile_uuid: 'cli-1',
        date_hint: ['2026-06-05'],
        time_hint: '14:00',
      },
      IDENTITY_CLIENT,
    );

    expect(result.passed).toBe(false);
    expect(result.proposed_slots).toHaveLength(2);
    expect(result.fallback?.kind).toBe('selection_list');
  });
});

describe('GuacucoClient.getStaffAppointmentsSummary', () => {
  it('derives staff context (profile/business uuids) from identity', async () => {
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
      IDENTITY_STAFF,
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
    await client.checkAvailability(
      {
        business_allia_id: 'allia-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
      },
      IDENTITY_CLIENT,
    );

    const sentBody = mockHttp.post.mock.calls[0]?.[1] as { tool_name: string; context: unknown };
    expect(sentBody.tool_name).toBe('check_availability');
    expect(sentBody.context).toEqual(CONTEXT_CLIENT);
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
    const result = await client.checkAvailability(
      {
        business_allia_id: 'allia-1',
        staff_uuid: 'stf-1',
        service_uuids: ['svc-1'],
        date: '2026-06-01',
        appointment_time: '10:00',
      },
      IDENTITY_CLIENT,
    );

    expect(result.available).toBe(true);
  });
});

describe('GuacucoClient.persistAgentTurns', () => {
  const samplePayload: PersistAgentTurnsRequest = {
    tenant_allia_id: 'allia-1',
    thread_id: 'biz-1:cli-1:whatsapp:1',
    profile_uuid: 'cli-1',
    profile_type: 'client',
    channel: 'whatsapp',
    platform_id: 1,
    turn_id: '660e8400-e29b-41d4-a716-446655440001',
    turns: [
      {
        role: 'user',
        content: 'hola',
        received_at: '2026-05-27T15:30:00Z',
        metadata: { message_id: 'wamid.ABC', interactive_payload: null },
      },
      {
        role: 'assistant',
        content: 'Hola, ¿en qué puedo ayudarte?',
        sent_at: '2026-05-27T15:30:02Z',
        outcome_action: 'response',
      },
    ],
  };

  it('posts payload to /api/v1/conversations/agent-turns and returns response', async () => {
    const mockHttp = makeMockHttp();
    const response: PersistAgentTurnsResponse = {
      turn_id: '660e8400-e29b-41d4-a716-446655440001',
      persisted: true,
    };
    mockHttp.post.mockResolvedValue(makeResponse({ success: true, data: response }, 202));

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.persistAgentTurns(samplePayload);

    expect(result).toEqual(response);
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/conversations/agent-turns', samplePayload);
  });

  it('returns persisted=false on duplicate turn_id (idempotent)', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse(
        {
          success: true,
          data: { turn_id: samplePayload.turn_id, persisted: false },
        },
        202,
      ),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.persistAgentTurns(samplePayload);

    expect(result.persisted).toBe(false);
    expect(result.turn_id).toBe(samplePayload.turn_id);
  });

  it('propagates backend errors as ToolExecutionError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'BUSINESS_NOT_FOUND', message: 'tenant missing' },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(client.persistAgentTurns(samplePayload)).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });
});

describe('GuacucoClient.getRecentTemplates', () => {
  const rawTemplate = (overrides: Record<string, unknown> = {}) => ({
    log_uuid: 'log-1',
    template_name: 'p11_appointment_reminder_24h',
    recipient_phone: '5491100',
    user_type: 'client',
    lang_code: 'es',
    parameters: [
      { type: 'text', text: 'Juan' },
      { type: 'text', text: '30/05/2026' },
      { type: 'text', text: '11:30' },
    ],
    channel_phone_number_id: 'pn-1',
    meta_message_id: 'wamid.ABC',
    status: 'sent',
    source_component: 'notification.appointment',
    metadata: { platform_id: 3, appointment_uuid: 'apt-1' },
    created_at: '2026-05-29T14:30:00Z',
    ...overrides,
  });

  it('GET /api/v1/template-send-log/recent with snake_case params + maps raw → camelCase', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: true,
        data: { templates: [rawTemplate()], count: 1, window_hours: 48 },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.getRecentTemplates({
      recipientPhone: '5491100',
      windowHours: 48,
      limit: 5,
      status: 'sent',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      templateName: 'p11_appointment_reminder_24h',
      userType: 'client',
      langCode: 'es',
      metaMessageId: 'wamid.ABC',
      status: 'sent',
      platformId: 3,
      createdAt: '2026-05-29T14:30:00Z',
    });
    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/template-send-log/recent', {
      params: { recipient_phone: '5491100', window_hours: 48, limit: 5, status: 'sent' },
    });
  });

  it('omits optional params when not provided', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({ success: true, data: { templates: [], count: 0, window_hours: 48 } }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await client.getRecentTemplates({ recipientPhone: '5491100' });

    expect(mockHttp.get).toHaveBeenCalledWith('/api/v1/template-send-log/recent', {
      params: { recipient_phone: '5491100' },
    });
  });

  it('coerces a numeric-string platform_id and defaults missing metadata to null', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: true,
        data: {
          templates: [
            rawTemplate({ metadata: { platform_id: '2' } }),
            rawTemplate({ log_uuid: 'log-2', metadata: null }),
          ],
          count: 2,
          window_hours: 48,
        },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.getRecentTemplates({ recipientPhone: '5491100' });

    expect(result[0]?.platformId).toBe(2);
    expect(result[1]?.platformId).toBeNull();
  });

  it('propagates backend errors as ToolExecutionError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.get.mockResolvedValue(
      makeResponse({
        success: false,
        error: { code: 'RECIPIENT_OR_MESSAGE_ID_REQUIRED', message: 'missing' },
      }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(client.getRecentTemplates({ recipientPhone: '' })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });
});

describe('GuacucoClient.triggerTakeover', () => {
  const samplePayload: TriggerTakeoverRequest = {
    tenant_allia_id: 'allia-1',
    thread_id: 'biz-1:cli-1:whatsapp:1',
    profile_uuid: 'cli-1',
    profile_type: 'client',
    channel: 'whatsapp',
    platform_id: 1,
    reason_code: 'explicit_request',
    subgraph: null,
    summary: 'El cliente pidió explícitamente hablar con una persona.',
    last_user_message: 'quiero hablar con alguien',
    ttl_seconds: 21600,
    idempotency_key: 'biz-1:cli-1:whatsapp:1:660e8400',
  };

  it('posts payload to /api/v1/conversations/takeover and returns result', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: true, data: { takeover_id: 'tk-1', created: true } }, 201),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.triggerTakeover(samplePayload);

    expect(result).toEqual({ takeover_id: 'tk-1', created: true });
    expect(mockHttp.post).toHaveBeenCalledWith('/api/v1/conversations/takeover', samplePayload);
  });

  it('returns created=false on duplicate (idempotent)', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: true, data: { takeover_id: 'tk-1', created: false } }, 200),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    const result = await client.triggerTakeover(samplePayload);
    expect(result.created).toBe(false);
  });

  it('propagates backend errors as ToolExecutionError', async () => {
    const mockHttp = makeMockHttp();
    mockHttp.post.mockResolvedValue(
      makeResponse({ success: false, error: { code: 'BUSINESS_NOT_FOUND', message: 'x' } }),
    );

    const client = new GuacucoClient(mockHttp as unknown as RetryClient, mockLogger);
    await expect(client.triggerTakeover(samplePayload)).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
