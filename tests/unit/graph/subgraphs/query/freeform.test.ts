import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type {
  QueryProcessorExecuteResponse,
  QueryProcessorSchemaResponse,
  QueryProcessorTablesResponse,
} from '../../../../../src/clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../../src/core/errors/ToolExecutionError.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeFetchIntentNode } from '../../../../../src/graph/subgraphs/query/nodes/fetchIntent.js';
import { makeSynthesizeResponseNode } from '../../../../../src/graph/subgraphs/query/nodes/synthesizeResponse.js';
import {
  type QueryDraftState,
  initialQueryDraftState,
} from '../../../../../src/graph/subgraphs/query/state.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY_STAFF: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-staff',
  profileType: 'staff',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
  roleId: 1,
};

const IDENTITY_CLIENT: Identity = {
  ...IDENTITY_STAFF,
  profileUuid: 'profile-client',
  profileType: 'client',
  roleId: undefined,
};

const IDENTITY_STAFF_NO_ROLE: Identity = {
  ...IDENTITY_STAFF,
  roleId: undefined,
};

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

function makeLlm(...replies: string[]): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const create = vi.fn(async () => stub(replies[i++] ?? ''));
  const client: AnthropicMessagesLike = { create };
  return {
    llm: new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client }),
    create,
  };
}

function readyFreeformDraft(text = 'cuántos turnos confirmados tengo este mes'): QueryDraftState {
  const d = initialQueryDraftState(text);
  d.intent = 'freeform_sql';
  d.phase = 'fetching';
  return d;
}

const TABLES_STAFF: QueryProcessorTablesResponse = [
  {
    table_name: 'front_sche.appointments_view',
    table_comment: 'Vista de turnos del negocio',
    columns: [
      { column_name: 'appointment_uuid', column_comment: null },
      { column_name: 'fecha', column_comment: 'DATO_LECTURA: Fecha del turno' },
      { column_name: 'status', column_comment: 'DATO_LECTURA: estado' },
      { column_name: 'staff_uuid', column_comment: null },
    ],
  },
];

const SCHEMA_VIEW: QueryProcessorSchemaResponse = {
  columns: [
    { column_name: 'appointment_uuid', data_type: 'uuid', is_nullable: 'NO', column_comment: null },
    { column_name: 'fecha', data_type: 'date', is_nullable: 'NO', column_comment: 'DATO_LECTURA' },
    {
      column_name: 'status',
      data_type: 'text',
      is_nullable: 'YES',
      column_comment: 'DATO_LECTURA',
    },
    { column_name: 'staff_uuid', data_type: 'uuid', is_nullable: 'NO', column_comment: null },
  ],
  foreignKeys: [],
};

function makeGuacuco(opts: {
  getTables?: () => Promise<QueryProcessorTablesResponse>;
  getSchema?: () => Promise<QueryProcessorSchemaResponse>;
  execute?: (sql: string) => Promise<QueryProcessorExecuteResponse>;
}): {
  guacuco: GuacucoClient;
  calls: {
    getTables: ReturnType<typeof vi.fn>;
    getSchema: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };
} {
  const getTables = vi.fn(opts.getTables ?? (async () => TABLES_STAFF));
  const getSchema = vi.fn(opts.getSchema ?? (async () => SCHEMA_VIEW));
  const execute = vi.fn(
    opts.execute ??
      (async () => ({ rows: [{ count: 2 }], rowCount: 1 }) as QueryProcessorExecuteResponse),
  );
  return {
    guacuco: {
      getQueryTables: getTables,
      getQueryTableSchema: getSchema,
      executeQuery: execute,
    } as unknown as GuacucoClient,
    calls: { getTables, getSchema, execute },
  };
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// freeform_sql happy path
// ============================================================================

describe('freeform_sql — happy path', () => {
  it('staff: schema → generate SQL → validate → execute → rawResult con rows', async () => {
    const sql =
      "SELECT count(*) AS count FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff' AND status = 'confirmed'";
    const { llm } = makeLlm(`{"answerable": true, "sql": ${JSON.stringify(sql)}}`);
    const { guacuco, calls } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect(update.phase).toBe('synthesizing');
    expect(calls.getTables).toHaveBeenCalledOnce();
    expect(calls.execute).toHaveBeenCalledWith(sql, 'staff', 1);
    const rawResult = update.rawResult as { rows: unknown[]; rowCount: number };
    expect(rawResult.rows).toEqual([{ count: 2 }]);
    expect(rawResult.rowCount).toBe(1);
    expect(update.generatedSql).toBe(sql);
  });

  it('client: usa schema client + sin role_id en execute', async () => {
    const sql =
      "SELECT count(*) AS count FROM front_sche_client.appointments_view WHERE client_uuid = 'profile-client'";
    const { llm } = makeLlm(`{"answerable": true, "sql": ${JSON.stringify(sql)}}`);
    const tables: QueryProcessorTablesResponse = [
      {
        table_name: 'front_sche_client.appointments_view',
        table_comment: null,
        columns: [{ column_name: 'client_uuid', column_comment: null }],
      },
    ];
    const { guacuco, calls } = makeGuacuco({
      getTables: async () => tables,
    });
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    await node({
      identity: IDENTITY_CLIENT,
      subgraphState: readyFreeformDraft('cuántos turnos tengo'),
    });
    expect(calls.execute).toHaveBeenCalledWith(sql, 'client', undefined);
    expect(calls.getTables).toHaveBeenCalledWith('client', undefined);
  });

  it('cache schema: 2da call NO refetcha tables', async () => {
    const sql =
      "SELECT count(*) AS count FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff'";
    const { llm } = makeLlm(
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
      `{"answerable": true, "sql": ${JSON.stringify(sql)}}`,
    );
    const { guacuco, calls } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    await node({ identity: IDENTITY_STAFF, subgraphState: readyFreeformDraft() });
    await node({ identity: IDENTITY_STAFF, subgraphState: readyFreeformDraft() });
    // 1ra vez fetcha, 2da hit cache.
    expect(calls.getTables).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// freeform_sql LLM rejection
// ============================================================================

describe('freeform_sql — LLM rejection', () => {
  it('answerable=false → rawResult.error=cannot_answer, no execute', async () => {
    const { llm } = makeLlm('{"answerable": false, "reason": "pregunta ambigua"}');
    const { guacuco, calls } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft('blabla blabla'),
    });
    expect(calls.execute).not.toHaveBeenCalled();
    const raw = update.rawResult as { error: string; reason?: string };
    expect(raw.error).toBe('cannot_answer');
    expect(raw.reason).toMatch(/ambigua/i);
    expect(update.phase).toBe('synthesizing');
  });

  it('JSON inválido → cannot_answer', async () => {
    const { llm } = makeLlm('no es json');
    const { guacuco } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect((update.rawResult as { error: string }).error).toBe('cannot_answer');
  });
});

// ============================================================================
// freeform_sql local validation
// ============================================================================

describe('freeform_sql — local validation', () => {
  it('SQL con DROP → rawResult.error=unsafe_sql, no execute', async () => {
    const { llm } = makeLlm(
      '{"answerable": true, "sql": "DROP TABLE front_sche.appointments_view"}',
    );
    const { guacuco, calls } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect(calls.execute).not.toHaveBeenCalled();
    const raw = update.rawResult as { error: string };
    expect(raw.error).toBe('unsafe_sql');
    expect(update.generatedSql).toMatch(/DROP/);
  });

  it('SQL con schema cross-tenant → rawResult.error=unsafe_sql', async () => {
    // Schema asignado para staff es front_sche; intentamos usar otro schema.
    const { llm } = makeLlm(
      '{"answerable": true, "sql": "SELECT * FROM front_sche_client.appointments_view LIMIT 5"}',
    );
    const { guacuco, calls } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect(calls.execute).not.toHaveBeenCalled();
    expect((update.rawResult as { error: string }).error).toBe('unsafe_sql');
  });

  it('staff sin roleId → rawResult.error=role_unavailable', async () => {
    const { llm, create } = makeLlm('should not be called');
    const { guacuco } = makeGuacuco({});
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF_NO_ROLE,
      subgraphState: readyFreeformDraft(),
    });
    expect(create).not.toHaveBeenCalled();
    expect((update.rawResult as { error: string }).error).toBe('role_unavailable');
  });
});

// ============================================================================
// freeform_sql execute retry
// ============================================================================

describe('freeform_sql — execute retry', () => {
  it('execute throw 1ra vez → retry con error context → 2da execute exitosa', async () => {
    const goodSql =
      "SELECT count(*) AS count FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff'";
    const { llm } = makeLlm(
      `{"answerable": true, "sql": "SELECT broken_col FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff'"}`,
      `{"answerable": true, "sql": ${JSON.stringify(goodSql)}}`,
    );
    let executeCount = 0;
    const { guacuco, calls } = makeGuacuco({
      execute: async () => {
        executeCount++;
        if (executeCount === 1)
          throw new ToolExecutionError('QUERY_EXECUTION_ERROR', 'column does not exist');
        return { rows: [{ count: 5 }], rowCount: 1 };
      },
    });
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect(calls.execute).toHaveBeenCalledTimes(2);
    expect(update.phase).toBe('synthesizing');
    const raw = update.rawResult as { rows: unknown[]; rowCount: number };
    expect(raw.rowCount).toBe(1);
  });

  it('execute throw 2 veces → rawResult.error=execute_failed', async () => {
    const { llm } = makeLlm(
      `{"answerable": true, "sql": "SELECT * FROM front_sche.appointments_view LIMIT 5"}`,
      `{"answerable": true, "sql": "SELECT * FROM front_sche.appointments_view LIMIT 5"}`,
    );
    const { guacuco, calls } = makeGuacuco({
      execute: async () => {
        throw new ToolExecutionError('QUERY_EXECUTION_ERROR', 'syntax error');
      },
    });
    const node = makeFetchIntentNode({ guacuco, llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyFreeformDraft(),
    });
    expect(calls.execute).toHaveBeenCalledTimes(2);
    expect((update.rawResult as { error: string }).error).toBe('execute_failed');
  });
});

// ============================================================================
// freeform_sql synthesizeResponse integration
// ============================================================================

describe('freeform_sql — synthesizeResponse', () => {
  it('rawResult.error → respuesta amable amable sin LLM call para freeform_error', async () => {
    const { llm, create } = makeLlm('should not be called');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('q'),
      intent: 'freeform_sql',
      rawResult: { error: 'unsafe_sql', reason: 'DROP not allowed' },
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    expect(create).not.toHaveBeenCalled();
    expect(update.phase).toBe('done');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(
      /no pude procesar|reformular|m[aá]s espec[ií]fico/i,
    );
  });

  it('rawResult con rows → LLM synthesize con datos', async () => {
    const { llm, create } = makeLlm('Tenés 2 turnos confirmados este mes.');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('cuántos turnos tengo'),
      intent: 'freeform_sql',
      rawResult: { rows: [{ count: 2 }], rowCount: 1, wasTruncated: false },
      generatedSql: 'SELECT count(*) ...',
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    expect(create).toHaveBeenCalledOnce();
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/2|turnos/i);
  });

  it('rawResult con rows pero LLM vacío → fallback formatRowsAsDetails (scalar)', async () => {
    const { llm } = makeLlm('');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('cuántos turnos'),
      intent: 'freeform_sql',
      rawResult: { rows: [{ total: 7 }], rowCount: 1, wasTruncated: false },
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    // formatScalarAggregate kicks in: "Total: 7"
    expect(update.terminalOutcome?.pendingReply?.text).toBe('Total: 7');
  });
});
