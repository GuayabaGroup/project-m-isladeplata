import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import {
  QueryJudge,
  type QueryJudgeConfig,
} from '../../../../../src/graph/subgraphs/query/queryJudge.js';
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

function out(partial: Partial<LlmCompleteOutput>): LlmCompleteOutput {
  return {
    text: partial.text ?? '',
    toolCalls: partial.toolCalls ?? [],
    stopReason: partial.stopReason ?? 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function makeLlm(...outputs: Partial<LlmCompleteOutput>[]): {
  llm: LlmProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const complete = vi.fn(async () => out(outputs[i++] ?? {}));
  return { llm: { complete } as unknown as LlmProvider, complete };
}

const CONFIG: QueryJudgeConfig = {
  model: 'claude-haiku-4-5-20251001',
  temperature: 0,
  maxTokens: 512,
  failMode: 'fail-open',
};

const SQL_ARGS = {
  question: '¿cuántos turnos tengo?',
  sql: "SELECT count(*) FROM s.turnos WHERE client_uuid = 'c1'",
  schemaText: 'TABLE s.turnos: client_uuid uuid',
  profileType: 'client' as const,
  profileUuid: 'c1',
  rows: [{ count: 2 }],
  rowCount: 1,
  history: undefined,
};

const SYNTH_ARGS = {
  question: '¿cuántos turnos tengo?',
  sql: "SELECT count(*) FROM s.turnos WHERE client_uuid = 'c1'",
  synthesisText: 'Tenés 2 turnos.',
  rows: [{ count: 2 }],
  rowCount: 1,
  history: undefined,
};

afterEach(() => vi.clearAllMocks());

describe('QueryJudge.validateSql', () => {
  it('approves when verdict JSON says approved', async () => {
    const { llm } = makeLlm({ text: '{"approved": true, "confidence": 0.9, "critique": "ok"}' });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSql(SQL_ARGS);
    expect(verdict.approved).toBe(true);
  });

  it('rejects and surfaces the critique when verdict says not approved', async () => {
    const { llm } = makeLlm({
      text: '{"approved": false, "confidence": 0.8, "critique": "falta filtro de perfil", "reason": "inseguro"}',
    });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSql(SQL_ARGS);
    expect(verdict.approved).toBe(false);
    expect(verdict.critique).toBe('falta filtro de perfil');
    expect(verdict.reason).toBe('inseguro');
  });

  it('fail-open: approves when the LLM errors (stopReason=error)', async () => {
    const { llm } = makeLlm({ stopReason: 'error', text: '' });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSql(SQL_ARGS);
    expect(verdict.approved).toBe(true);
    expect(verdict.reason).toBe('judge_error_fail_open');
  });

  it('fail-open: approves when the verdict is not parseable JSON', async () => {
    const { llm } = makeLlm({ text: 'no soy json' });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSql(SQL_ARGS);
    expect(verdict.approved).toBe(true);
  });

  it('fail-closed: rejects when the LLM errors', async () => {
    const { llm } = makeLlm({ stopReason: 'error', text: '' });
    const verdict = await new QueryJudge(llm, logger, {
      ...CONFIG,
      failMode: 'fail-closed',
    }).validateSql(SQL_ARGS);
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('judge_unavailable_fail_closed');
  });
});

describe('QueryJudge.validateSynthesis', () => {
  it('approves a faithful synthesis', async () => {
    const { llm, complete } = makeLlm({ text: '{"approved": true, "confidence": 0.95}' });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSynthesis(SYNTH_ARGS);
    expect(verdict.approved).toBe(true);
    // Verifica que la pregunta y la síntesis viajan en el prompt del judge.
    const callArg = complete.mock.calls[0]?.[0] as { messages: { content: string }[] };
    expect(callArg.messages[0]?.content).toContain('Tenés 2 turnos.');
  });

  it('rejects a synthesis that invents data', async () => {
    const { llm } = makeLlm({
      text: '{"approved": false, "critique": "menciona un nombre ausente en los rows"}',
    });
    const verdict = await new QueryJudge(llm, logger, CONFIG).validateSynthesis(SYNTH_ARGS);
    expect(verdict.approved).toBe(false);
  });
});
