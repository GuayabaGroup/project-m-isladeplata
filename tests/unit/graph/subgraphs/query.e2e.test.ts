/**
 * E2E del subgrafo query via parent graph. Verifica wire en compile.ts:
 * classifier global (messageType='query') → query_dispatch → classify_query
 * (interno) → fetch/synthesize → finalize → outcome global.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../src/clients/GuacucoClient.js';
import type { GetStaffAppointmentsSummaryResult } from '../../../../src/clients/types/GuacucoTypes.js';
import type { CatalogState } from '../../../../src/core/types/Catalog.js';
import type {
  ChannelMessage,
  InteractivePayload,
} from '../../../../src/core/types/ChannelMessage.js';
import type { CrmContext } from '../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../src/core/types/Identity.js';
import { compileGraph } from '../../../../src/graph/compile.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-client',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
  tenantName: 'Estética Norte',
};

const IDENTITY_STAFF: Identity = {
  ...IDENTITY_CLIENT,
  profileUuid: 'profile-staff',
  profileType: 'staff',
  roleId: 1, // Owner — required para freeform_sql que resuelve allowedSchema
};

const CATALOG: CatalogState = {
  services: [
    {
      uuid: 'svc-corte',
      name: 'Corte',
      description: 'Corte de pelo',
      price: 5000,
      staff: [{ uuid: 'stf-1', name: 'María' }],
    },
    {
      uuid: 'svc-color',
      name: 'Color',
      description: null,
      price: 12000,
      staff: [{ uuid: 'stf-1', name: 'María' }],
    },
  ],
};

const CRM_TWO: CrmContext = {
  upcomingAppointments: [
    { appointmentUuid: 'apt-1', description: 'Corte mañana 16:00', startAt: '2026-05-28T16:00' },
    { appointmentUuid: 'apt-2', description: 'Color viernes 10:00', startAt: '2026-06-04T10:00' },
  ],
  profileMeta: {},
};

const CRM_EMPTY: CrmContext = { upcomingAppointments: [], profileMeta: {} };

function makeMessage(
  contentText: string,
  interactivePayload: InteractivePayload | null = null,
): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: `wamid.${Math.random().toString(36).slice(2)}`,
    contentType: interactivePayload ? 'interactive' : 'text',
    contentText,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload,
  };
}

function stub(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    container: null,
  } as Anthropic.Messages.Message;
}

function makeSeqLlm(replies: string[]): AnthropicProvider {
  let i = 0;
  const create = vi.fn(async () => stub(replies[i++] ?? ''));
  const client: AnthropicMessagesLike = { create };
  return new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
}

function makeGuacuco(opts: {
  staffSummary?: () => Promise<GetStaffAppointmentsSummaryResult>;
}): {
  guacuco: GuacucoClient;
  calls: { staffSummary: ReturnType<typeof vi.fn> };
} {
  const staffSummary = vi.fn(
    opts.staffSummary ??
      (async () =>
        ({
          response_type: 'text',
          message: '2 turnos hoy',
          summary: 'Hoy: 10:00 Corte (Juan), 14:00 Color (Ana)',
          total: 2,
          date_start: '2026-05-28',
          date_end: '2026-05-28',
          appointments: [],
        }) as GetStaffAppointmentsSummaryResult),
  );
  return {
    guacuco: {
      getStaffAppointmentsSummary: staffSummary,
    } as unknown as GuacucoClient,
    calls: { staffSummary },
  };
}

function freshInvoke(
  message: ChannelMessage,
  identity: Identity,
  crm: CrmContext,
  catalog: CatalogState = CATALOG,
) {
  return {
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity,
    crmContext: crm,
    catalog,
  };
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// #1: service_prices client → lookup catalog → synthesize
// ============================================================================

describe('query E2E #1: service_prices (client)', () => {
  it('client pregunta precio → catalog lookup → synthesize Haiku', async () => {
    const llm = makeSeqLlm([
      // global classifier
      '{"messageType":"query","confidence":0.95}',
      // query.classifyQuery (interno)
      '{"intent":"service_prices","confidence":0.9}',
      // synthesize
      'Corte cuesta $5000 y Color $12000. ¿Querés agendar alguno?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('cuánto cuesta corte'), IDENTITY_CLIENT, CRM_EMPTY),
      { configurable: { thread_id: 'q-1' } },
    );
    expect(calls.staffSummary).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/5000|12000/);
  });
});

// ============================================================================
// #2: my_upcoming → crmContext lookup
// ============================================================================

describe('query E2E #2: my_upcoming', () => {
  it('client pregunta turnos → crmContext lookup → synthesize', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.92}',
      '{"intent":"my_upcoming","confidence":0.88}',
      'Tenés 2 turnos: Corte mañana 16:00 y Color el viernes 10:00.',
    ]);
    const { guacuco } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('tengo turnos próximos'), IDENTITY_CLIENT, CRM_TWO),
      { configurable: { thread_id: 'q-2' } },
    );
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/Corte|Color/);
  });
});

// ============================================================================
// #3: staff_schedule_day para staff → Guacuco call → synthesize
// ============================================================================

describe('query E2E #3: staff_schedule_day (staff)', () => {
  it('staff pregunta agenda hoy → Guacuco call → synthesize', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.95}',
      '{"intent":"staff_schedule_day","confidence":0.9}',
      'Hoy tenés 2 turnos: 10:00 Corte con Juan y 14:00 Color con Ana.',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('qué turnos tengo hoy'), IDENTITY_STAFF, CRM_EMPTY),
      { configurable: { thread_id: 'q-3' } },
    );
    expect(calls.staffSummary).toHaveBeenCalledOnce();
    const [params, identity] = calls.staffSummary.mock.calls[0] ?? [];
    expect((params as { date_start: string }).date_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(identity).toEqual(IDENTITY_STAFF);
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/10:00|14:00/);
  });
});

// ============================================================================
// #4: staff_schedule_day para client → classifier interno rebaja a cannot_answer
// ============================================================================

describe('query E2E #4: staff_schedule_day para client → cannot_answer', () => {
  it('client pregunta agenda → classifier rebaja → respuesta amable, no Guacuco', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.92}',
      // El classifier interno usa prompt CLIENT que no incluye staff_schedule_day,
      // pero si el LLM lo devuelve igual, el normalize lo rebaja a cannot_answer.
      '{"intent":"staff_schedule_day","confidence":0.7}',
      'Eso no lo puedo responder. ¿Te ayudo con precios o tus turnos próximos?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('qué tengo hoy en la agenda'), IDENTITY_CLIENT, CRM_EMPTY),
      { configurable: { thread_id: 'q-4' } },
    );
    expect(calls.staffSummary).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
  });
});

// ============================================================================
// #5: pregunta off-topic → cannot_answer → respuesta amable
// ============================================================================

describe('query E2E #5: off-topic → cannot_answer', () => {
  it('pregunta off-topic → cannot_answer + respuesta amable', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.7}',
      '{"intent":"cannot_answer","confidence":0.85}',
      'Eso no lo manejo. ¿Te ayudo con precios, servicios o turnos?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('cómo está el clima'), IDENTITY_CLIENT, CRM_EMPTY),
      { configurable: { thread_id: 'q-5' } },
    );
    expect(calls.staffSummary).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no lo manejo|precios|turnos/i);
  });
});

// ============================================================================
// #6: Guacuco falla → error terminal
// ============================================================================

describe('query E2E #6: staff_schedule_day con Guacuco failure', () => {
  it('Guacuco throw → outcome=error con texto amable', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.95}',
      '{"intent":"staff_schedule_day","confidence":0.9}',
    ]);
    const { guacuco } = makeGuacuco({
      staffSummary: async () => {
        throw new Error('upstream 500');
      },
    });
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('qué turnos tengo hoy'), IDENTITY_STAFF, CRM_EMPTY),
      { configurable: { thread_id: 'q-6' } },
    );
    expect(result.outcome?.action).toBe('error');
    expect(result.outcome?.pendingReply?.text).toMatch(/no pude consultar/i);
  });
});

// ============================================================================
// freeform_sql E2E
// ============================================================================

describe('query E2E #7: freeform_sql happy (staff)', () => {
  it('classify freeform → load schema → generate SQL → validate → execute → synthesize', async () => {
    const sql =
      "SELECT count(*) AS count FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff' AND status = 'confirmed'";
    const llm = makeSeqLlm([
      // global classifier
      '{"messageType":"query","confidence":0.92}',
      // query.classifyQuery
      '{"intent":"freeform_sql","confidence":0.88}',
      // generateSql
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
      // synthesizeResponse
      'Tenés 5 turnos confirmados este mes.',
    ]);
    const calls = {
      getTables: vi.fn(async () => [
        {
          table_name: 'front_sche.appointments_view',
          table_comment: null,
          columns: [{ column_name: 'staff_uuid', column_comment: null }],
        },
      ]),
      getSchema: vi.fn(async () => ({
        columns: [
          {
            column_name: 'staff_uuid',
            data_type: 'uuid',
            is_nullable: 'NO',
            column_comment: null,
          },
        ],
        foreignKeys: [],
      })),
      execute: vi.fn(async () => ({ rows: [{ count: 5 }], rowCount: 1 })),
    };
    const guacuco = {
      getQueryTables: calls.getTables,
      getQueryTableSchema: calls.getSchema,
      executeQuery: calls.execute,
    } as unknown as GuacucoClient;
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(
        makeMessage('cuántos turnos confirmados tengo este mes'),
        IDENTITY_STAFF,
        CRM_EMPTY,
      ),
      { configurable: { thread_id: 'q-7' } },
    );
    expect(calls.execute).toHaveBeenCalledOnce();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/5|turnos|confirmados/i);
  });
});

describe('query E2E #8: freeform_sql con SQL inválida (DROP) → unsafe_sql', () => {
  it('LLM devuelve DROP → validate local rechaza → no execute → respuesta amable', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.9}',
      '{"intent":"freeform_sql","confidence":0.85}',
      '{"answerable": true, "sql": "DROP TABLE front_sche.appointments_view"}',
    ]);
    const calls = {
      getTables: vi.fn(async () => [
        {
          table_name: 'front_sche.appointments_view',
          table_comment: null,
          columns: [],
        },
      ]),
      getSchema: vi.fn(async () => ({ columns: [], foreignKeys: [] })),
      execute: vi.fn(),
    };
    const guacuco = {
      getQueryTables: calls.getTables,
      getQueryTableSchema: calls.getSchema,
      executeQuery: calls.execute,
    } as unknown as GuacucoClient;
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('borrame todo'), IDENTITY_STAFF, CRM_EMPTY),
      { configurable: { thread_id: 'q-8' } },
    );
    expect(calls.execute).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(
      /no pude procesar|reformular|espec[ií]fico/i,
    );
  });
});

describe('query E2E #9: freeform_sql client → schema client + sin role_id', () => {
  it('client pregunta freeform → resuelve schema front_sche_client → execute con profile_type=client', async () => {
    const sql =
      "SELECT count(*) AS total FROM front_sche_client.appointments_view WHERE client_uuid = 'profile-client'";
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.9}',
      '{"intent":"freeform_sql","confidence":0.85}',
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
      'Fuiste al negocio 3 veces este año.',
    ]);
    const calls = {
      getTables: vi.fn(async () => [
        {
          table_name: 'front_sche_client.appointments_view',
          table_comment: null,
          columns: [{ column_name: 'client_uuid', column_comment: null }],
        },
      ]),
      getSchema: vi.fn(async () => ({ columns: [], foreignKeys: [] })),
      execute: vi.fn(async () => ({ rows: [{ total: 3 }], rowCount: 1 })),
    };
    const guacuco = {
      getQueryTables: calls.getTables,
      getQueryTableSchema: calls.getSchema,
      executeQuery: calls.execute,
    } as unknown as GuacucoClient;
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('cuántas veces fui al negocio este año'), IDENTITY_CLIENT, CRM_EMPTY),
      { configurable: { thread_id: 'q-9' } },
    );
    expect(calls.getTables).toHaveBeenCalledWith('client', undefined);
    expect(calls.execute).toHaveBeenCalledWith(sql, 'client', undefined);
    expect(result.outcome?.action).toBe('response');
  });
});

describe('query E2E #10: freeform_sql Guacuco execute throw → retry → fail → response amable', () => {
  it('execute falla 2 veces → outcome response con texto execute_failed', async () => {
    const sql = 'SELECT * FROM front_sche.appointments_view LIMIT 5';
    const llm = makeSeqLlm([
      '{"messageType":"query","confidence":0.9}',
      '{"intent":"freeform_sql","confidence":0.85}',
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
    ]);
    const calls = {
      getTables: vi.fn(async () => [
        {
          table_name: 'front_sche.appointments_view',
          table_comment: null,
          columns: [],
        },
      ]),
      getSchema: vi.fn(async () => ({ columns: [], foreignKeys: [] })),
      execute: vi.fn(async () => {
        throw new Error('syntax error');
      }),
    };
    const guacuco = {
      getQueryTables: calls.getTables,
      getQueryTableSchema: calls.getSchema,
      executeQuery: calls.execute,
    } as unknown as GuacucoClient;
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(
      freshInvoke(makeMessage('mostrame turnos'), IDENTITY_STAFF, CRM_EMPTY),
      { configurable: { thread_id: 'q-10' } },
    );
    expect(calls.execute).toHaveBeenCalledTimes(2);
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no pudo ejecutarse|probá de nuevo/i);
  });
});
