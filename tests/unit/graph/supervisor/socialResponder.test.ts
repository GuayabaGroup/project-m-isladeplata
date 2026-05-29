import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../src/graph/state.js';
import { makeSocialResponderNode } from '../../../../src/graph/supervisor/socialResponder.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStubMessage(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: text.length
      ? ([{ type: 'text', text, citations: null }] as Anthropic.Messages.ContentBlock[])
      : ([] as Anthropic.Messages.ContentBlock[]),
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
  const create = vi.fn(async () => makeStubMessage(reply));
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { llm, create };
}

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'p-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
  tenantName: 'Estética Norte',
};

function makeState(
  contentText: string,
  messageType: GraphState['routing']['messageType'],
): GraphState {
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
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: IDENTITY,
    crmContext: EMPTY_CRM_CONTEXT,
    routing: { messageType, confidence: 0.9 },
    subgraphState: null,
    outcome: null,
  };
}

afterEach(() => vi.clearAllMocks());

describe('socialResponder node', () => {
  it('returns response outcome with LLM-generated text on greeting', async () => {
    const { llm, create } = makeProvider('¡Hola! ¿En qué puedo ayudarte hoy?');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola buenas', 'greeting'));
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toBe('¡Hola! ¿En qué puedo ayudarte hoy?');
    expect(create).toHaveBeenCalledOnce();
  });

  it('injects business name into system prompt', async () => {
    const { llm, create } = makeProvider('Hi');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    await node(makeState('hola', 'greeting'));
    const params = create.mock.calls[0]?.[0];
    expect(params?.system).toContain('Estética Norte');
    expect(params?.system).toContain('Allia');
  });

  it('uses farewell-specific prompt for messageType=farewell', async () => {
    const { llm, create } = makeProvider('Chau');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    await node(makeState('chau', 'farewell'));
    const params = create.mock.calls[0]?.[0];
    expect(params?.system).toMatch(/despide|despid/i);
  });

  it('uses oos-specific prompt for messageType=oos', async () => {
    const { llm, create } = makeProvider('Solo turnos.');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    await node(makeState('cómo está el clima', 'oos'));
    const params = create.mock.calls[0]?.[0];
    expect(params?.system).toMatch(/scope|redirig/i);
  });

  it('falls back to deterministic text when LLM returns empty', async () => {
    const { llm } = makeProvider('');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola', 'greeting'));
    expect(update.outcome?.pendingReply?.text).toBeTruthy();
    expect(update.outcome?.pendingReply?.text).toMatch(/Hola/);
  });

  it('does not send conversation history to LLM (only current turn)', async () => {
    const { llm, create } = makeProvider('OK');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    const state = makeState('hola', 'greeting');
    await node(state);
    const params = create.mock.calls[0]?.[0];
    expect(params?.messages).toHaveLength(1);
    expect(params?.messages?.[0]?.role).toBe('user');
  });

  it('uses generic platform name when platformId is unknown', async () => {
    const { llm, create } = makeProvider('OK');
    const node = makeSocialResponderNode({ llm, logger: mockLogger });
    const state = makeState('hola', 'greeting');
    state.identity = { ...IDENTITY, platformId: 99 };
    await node(state);
    const params = create.mock.calls[0]?.[0];
    expect(params?.system).toContain('la plataforma');
  });
});
