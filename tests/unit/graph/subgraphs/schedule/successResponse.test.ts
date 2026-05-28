import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { makeSuccessResponseNode } from '../../../../../src/graph/subgraphs/schedule/nodes/successResponse.js';
import {
  type AppointmentDraftState,
  initialAppointmentDraftState,
} from '../../../../../src/graph/subgraphs/schedule/state.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStub(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text, citations: null }] as Anthropic.Messages.ContentBlock[],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Messages.Usage,
    container: null,
  } as Anthropic.Messages.Message;
}

function makeProvider(reply: string): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => makeStub(reply));
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { llm, create };
}

function makeDoneDraft(): AppointmentDraftState {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-corte'], displayName: 'Corte', status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', displayName: 'María García', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  d.phase = 'done';
  return d;
}

afterEach(() => vi.clearAllMocks());

describe('successResponse', () => {
  it('returns terminalOutcome with LLM text on happy path', async () => {
    const { llm } = makeProvider(
      '¡Listo! Agendé tu Corte con María García el jueves 28 de mayo a las 16:00. ¡Te esperamos!',
    );
    const node = makeSuccessResponseNode({ llm, logger: mockLogger });
    const update = await node({ subgraphState: makeDoneDraft() });

    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toContain('Corte');
  });

  it('passes display names (NOT uuids) and rendered date to the prompt', async () => {
    const { llm, create } = makeProvider('ok');
    const node = makeSuccessResponseNode({ llm, logger: mockLogger });
    await node({ subgraphState: makeDoneDraft() });

    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).toContain('Corte');
    expect(userMsg).toContain('María García');
    expect(userMsg).toContain('jueves 28 de mayo');
    expect(userMsg).not.toContain('svc-corte');
    expect(userMsg).not.toContain('stf-maria');
  });

  it('falls back to deterministic text if LLM returns empty', async () => {
    const { llm } = makeProvider('');
    const node = makeSuccessResponseNode({ llm, logger: mockLogger });
    const update = await node({ subgraphState: makeDoneDraft() });
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/agendé|listo/i);
    expect(update.terminalOutcome?.pendingReply?.text).toContain('Corte');
  });

  it('returns no-op if slots not resolved (defensive)', async () => {
    const draft = initialAppointmentDraftState('client');
    const { llm, create } = makeProvider('unused');
    const node = makeSuccessResponseNode({ llm, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(create).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });
});
