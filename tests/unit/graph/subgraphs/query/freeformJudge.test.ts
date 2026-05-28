import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type {
  QueryProcessorExecuteResponse,
  QueryProcessorSchemaResponse,
  QueryProcessorTablesResponse,
} from '../../../../../src/clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeFetchIntentNode } from '../../../../../src/graph/subgraphs/query/nodes/fetchIntent.js';
import { makeSynthesizeResponseNode } from '../../../../../src/graph/subgraphs/query/nodes/synthesizeResponse.js';
import { QueryJudge } from '../../../../../src/graph/subgraphs/query/queryJudge.js';
import { formatRowsAsDetails } from '../../../../../src/graph/subgraphs/query/resultFormatter.js';
import {
  type QueryDraftState,
  initialQueryDraftState,
} from '../../../../../src/graph/subgraphs/query/state.js';
import type {
  LlmCompleteOutput,
  LlmProvider,
} from '../../../../../src/infrastructure/llm/LlmProvider.js';

const logger = {
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

const JUDGE_CONFIG = {
  model: 'm',
  temperature: 0,
  maxTokens: 512,
  failMode: 'fail-open' as const,
};

const TABLES: QueryProcessorTablesResponse = [
  {
    table_name: 'front_sche.appointments_view',
    table_comment: null,
    columns: [
      { column_name: 'fecha', column_comment: 'DATO_LECTURA' },
      { column_name: 'status', column_comment: 'DATO_LECTURA' },
      { column_name: 'staff_uuid', column_comment: null },
    ],
  },
];
const SCHEMA: QueryProcessorSchemaResponse = {
  columns: [
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

function out(text: string, stopReason = 'end_turn'): LlmCompleteOutput {
  return { text, toolCalls: [], stopReason, usage: { inputTokens: 0, outputTokens: 0 } };
}

function makeLlm(...texts: string[]): { llm: LlmProvider; complete: ReturnType<typeof vi.fn> } {
  let i = 0;
  const complete = vi.fn(async () => out(texts[i++] ?? ''));
  return { llm: { complete } as unknown as LlmProvider, complete };
}

function makeGuacuco(execute: (sql: string) => Promise<QueryProcessorExecuteResponse>) {
  const exec = vi.fn(execute);
  return {
    guacuco: {
      getQueryTables: vi.fn(async () => TABLES),
      getQueryTableSchema: vi.fn(async () => SCHEMA),
      executeQuery: exec,
    } as unknown as GuacucoClient,
    exec,
  };
}

function freeformDraft(text: string): QueryDraftState {
  const d = initialQueryDraftState(text);
  d.intent = 'freeform_sql';
  d.phase = 'fetching';
  return d;
}

const SQL_OK =
  "SELECT fecha, status FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff' LIMIT 25";
const SQL_OK_2 =
  "SELECT fecha, status FROM front_sche.appointments_view WHERE staff_uuid = 'profile-staff' AND status = 'confirmed' LIMIT 25";

const DRILLDOWN_HISTORY = [
  new HumanMessage('¿cuántos turnos tengo este mes?'),
  new AIMessage('Tenés 2 turnos este mes.'),
];

afterEach(() => vi.clearAllMocks());

describe('fetchIntent — drill-down retry', () => {
  it('regenerates SQL when first gen is unanswerable but history looks like drill-down', async () => {
    // 1ª gen: rechaza; 2ª gen (drill-down retry): SQL válido.
    const { llm, complete } = makeLlm(
      '{"answerable": false, "reason": "ambigua"}',
      `{"answerable": true, "sql": ${JSON.stringify(SQL_OK)}}`,
    );
    const { guacuco, exec } = makeGuacuco(async () => ({
      rows: [{ fecha: '2026-05-30' }],
      rowCount: 1,
    }));
    const node = makeFetchIntentNode({ guacuco, llm, logger });

    const update = await node({
      identity: IDENTITY_STAFF,
      messages: DRILLDOWN_HISTORY,
      subgraphState: freeformDraft('con quién y qué servicios'),
    });

    expect(complete).toHaveBeenCalledTimes(2); // gen + drill-down retry
    expect(exec).toHaveBeenCalledWith(SQL_OK, 'staff', 1);
    expect(update.phase).toBe('synthesizing');
    expect(update.generatedSql).toBe(SQL_OK);
  });

  it('does NOT retry when history has no quantitative antecedent', async () => {
    const { llm, complete } = makeLlm('{"answerable": false, "reason": "ambigua"}');
    const { guacuco, exec } = makeGuacuco(async () => ({ rows: [], rowCount: 0 }));
    const node = makeFetchIntentNode({ guacuco, llm, logger });

    const update = await node({
      identity: IDENTITY_STAFF,
      messages: [new HumanMessage('hola')],
      subgraphState: freeformDraft('detalles'),
    });

    expect(complete).toHaveBeenCalledTimes(1); // sin retry
    expect(exec).not.toHaveBeenCalled();
    expect((update.rawResult as { error?: string }).error).toBe('cannot_answer');
  });
});

describe('fetchIntent — judge SQL', () => {
  it('regenerates + re-executes when the judge rejects the SQL', async () => {
    const { llm } = makeLlm(
      `{"answerable": true, "sql": ${JSON.stringify(SQL_OK)}}`, // gen 1
      `{"answerable": true, "sql": ${JSON.stringify(SQL_OK_2)}}`, // gen 2 (post-critique)
    );
    const { guacuco, exec } = makeGuacuco(async () => ({
      rows: [{ fecha: '2026-05-30' }],
      rowCount: 1,
    }));
    // Judge con su propio LLM: rechaza una vez.
    const { llm: judgeLlm, complete: judgeComplete } = makeLlm(
      '{"approved": false, "critique": "falta filtro status"}',
    );
    const judge = new QueryJudge(judgeLlm, logger, JUDGE_CONFIG);
    const node = makeFetchIntentNode({ guacuco, llm, logger, judge });

    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: freeformDraft('mis turnos'),
    });

    expect(judgeComplete).toHaveBeenCalledTimes(1); // juzga una vez, no re-juzga
    expect(exec).toHaveBeenNthCalledWith(1, SQL_OK, 'staff', 1);
    expect(exec).toHaveBeenNthCalledWith(2, SQL_OK_2, 'staff', 1);
    expect(update.generatedSql).toBe(SQL_OK_2);
  });

  it('keeps the original result when the judge approves', async () => {
    const { llm } = makeLlm(`{"answerable": true, "sql": ${JSON.stringify(SQL_OK)}}`);
    const { guacuco, exec } = makeGuacuco(async () => ({
      rows: [{ fecha: '2026-05-30' }],
      rowCount: 1,
    }));
    const { llm: judgeLlm } = makeLlm('{"approved": true}');
    const judge = new QueryJudge(judgeLlm, logger, JUDGE_CONFIG);
    const node = makeFetchIntentNode({ guacuco, llm, logger, judge });

    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: freeformDraft('mis turnos'),
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(update.generatedSql).toBe(SQL_OK);
  });
});

describe('synthesizeResponse — judge síntesis', () => {
  const ROWS = [{ fecha: '2026-05-30', status: 'confirmed' }];

  function freeformSynthState(): QueryDraftState {
    const d = freeformDraft('¿cuáles son?');
    d.phase = 'synthesizing';
    d.generatedSql = SQL_OK;
    d.rawResult = { rows: ROWS, rowCount: 1, wasTruncated: false };
    return d;
  }

  it('falls back to formatRowsAsDetails when the judge rejects both attempts', async () => {
    // synth llm: 1ª síntesis + retry síntesis (ambas con texto).
    const { llm: synthLlm } = makeLlm('Síntesis inventada A', 'Síntesis inventada B');
    // judge llm: rechaza ambas veces.
    const { llm: judgeLlm } = makeLlm(
      '{"approved": false, "critique": "inventa datos"}',
      '{"approved": false, "critique": "sigue inventando"}',
    );
    const judge = new QueryJudge(judgeLlm, logger, JUDGE_CONFIG);
    const node = makeSynthesizeResponseNode({ llm: synthLlm, logger, judge });

    const update = await node({ subgraphState: freeformSynthState() });

    expect(update.terminalOutcome?.pendingReply?.text).toBe(formatRowsAsDetails(ROWS, 1));
  });

  it('keeps the retried synthesis when the judge approves it', async () => {
    const { llm: synthLlm } = makeLlm('Síntesis mala', 'Síntesis corregida');
    const { llm: judgeLlm } = makeLlm(
      '{"approved": false, "critique": "corregí"}',
      '{"approved": true}',
    );
    const judge = new QueryJudge(judgeLlm, logger, JUDGE_CONFIG);
    const node = makeSynthesizeResponseNode({ llm: synthLlm, logger, judge });

    const update = await node({ subgraphState: freeformSynthState() });

    expect(update.terminalOutcome?.pendingReply?.text).toBe('Síntesis corregida');
  });
});
