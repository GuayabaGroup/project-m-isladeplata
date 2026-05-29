import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeEntryNode } from '../../../../../src/graph/subgraphs/schedule/nodes/entry.js';
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

const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-client',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const FIXED_NOW = new Date('2026-05-27T12:00:00Z');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => vi.clearAllMocks());

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

function makeProvider(reply: string): AnthropicProvider {
  const create = vi.fn(async () => makeStub(reply));
  const client: AnthropicMessagesLike = { create };
  return new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
}

function makeState(
  contentText: string,
  draft?: AppointmentDraftState,
): {
  input: { channelMessage: ChannelMessage };
  identity: Identity;
  subgraphState: AppointmentDraftState;
} {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload: null,
  };
  return {
    input: { channelMessage: message },
    identity: IDENTITY_CLIENT,
    subgraphState: draft ?? initialAppointmentDraftState('client'),
  };
}

describe('schedule.entry node', () => {
  it('extracts services + staff + date + time happy path', async () => {
    const llm = makeProvider(
      '{"services":"corte","staff":"María","date":"mañana","time":"a las 4"}',
    );
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('Quiero un turno para corte mañana a las 4 con María'));

    expect(update.slots?.services).toEqual({
      userPhrase: 'corte',
      status: 'guessed',
    });
    expect(update.slots?.staff).toEqual({
      userPhrase: 'María',
      status: 'guessed',
    });
    expect(update.slots?.date).toEqual({
      value: '2026-05-28',
      userPhrase: 'mañana',
      status: 'resolved',
    });
    expect(update.slots?.time).toEqual({
      value: '16:00',
      userPhrase: 'a las 4',
      status: 'resolved',
    });
  });

  it('keeps slot in guessed when date is unparseable', async () => {
    const llm = makeProvider('{"date":"alguna fecha rara"}');
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('quiero un turno alguna fecha rara'));
    expect(update.slots?.date.status).toBe('guessed');
    expect(update.slots?.date.userPhrase).toBe('alguna fecha rara');
    expect(update.slots?.date.value).toBeUndefined();
  });

  it('returns phase only when text is empty', async () => {
    const llm = makeProvider('unused');
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('   '));
    expect(update.phase).toBe('resolving_entities');
    expect(update.slots).toBeUndefined();
  });

  it('handles LLM returning prose (no JSON) gracefully', async () => {
    const llm = makeProvider('I will help you book!');
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('quiero un turno'));
    // No entities extracted → slots stay empty
    expect(update.slots?.services.status).toBe('empty');
    expect(update.slots?.staff.status).toBe('empty');
  });

  it('does not overwrite a previously resolved slot', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.staff = { value: 'stf-1', displayName: 'Juan', status: 'resolved' };
    draft.phase = 'resolving_entities';
    const llm = makeProvider('{"staff":"María"}');
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('cambio a María', draft));
    expect(update.slots?.staff).toEqual({
      value: 'stf-1',
      displayName: 'Juan',
      status: 'resolved',
    });
  });

  it('skips extraction entirely if phase is not resolving_entities', async () => {
    const create = vi.fn(async () => makeStub('{"services":"corte"}'));
    const client: AnthropicMessagesLike = { create };
    const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });

    const draft = initialAppointmentDraftState('client');
    draft.phase = 'awaiting_confirmation';
    const node = makeEntryNode({ llm, logger: mockLogger });
    const update = await node(makeState('algo', draft));
    expect(create).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });
});
