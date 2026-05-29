import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../src/graph/state.js';
import { makeClassifyIntentNode } from '../../../../src/graph/supervisor/classifyIntent.js';
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

function makeProvider(text: string): AnthropicProvider {
  const client: AnthropicMessagesLike = { create: vi.fn(async () => makeStubMessage(text)) };
  return new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
}

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'p-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeState(contentText: string): GraphState {
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
    routing: {},
    subgraphState: null,
    outcome: null,
  };
}

afterEach(() => vi.clearAllMocks());

describe('classifyIntent node', () => {
  it('parses greeting JSON happy path', async () => {
    const llm = makeProvider('{"messageType":"greeting","confidence":0.95}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola buenas'));
    expect(update.routing).toEqual({
      messageType: 'greeting',
      confidence: 0.95,
    });
  });

  it('parses action with intent', async () => {
    const llm = makeProvider('{"messageType":"action","intent":"schedule","confidence":0.85}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('quiero agendar para mañana'));
    expect(update.routing).toEqual({
      messageType: 'action',
      intent: 'schedule',
      confidence: 0.85,
    });
  });

  it('parses JSON embedded in markdown fence', async () => {
    const llm = makeProvider('```json\n{"messageType":"farewell","confidence":0.9}\n```');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('chau'));
    expect(update.routing?.messageType).toBe('farewell');
  });

  it('fails open to action/unknown/0.3 when LLM returns prose', async () => {
    const llm = makeProvider('I am happy to help!');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('algo raro'));
    expect(update.routing).toEqual({
      messageType: 'action',
      intent: 'unknown',
      confidence: 0.3,
    });
  });

  it('fails open when LLM throws (provider returns blank output)', async () => {
    const client: AnthropicMessagesLike = {
      create: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola'));
    expect(update.routing?.messageType).toBe('action');
    expect(update.routing?.intent).toBe('unknown');
  });

  it('normalizes invalid messageType to action/unknown', async () => {
    const llm = makeProvider('{"messageType":"flirty","confidence":0.4}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola'));
    expect(update.routing?.messageType).toBe('action');
    expect(update.routing?.intent).toBe('unknown');
  });

  it('clamps confidence to [0,1]', async () => {
    const llm = makeProvider('{"messageType":"query","confidence":1.5}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('cuánto cuesta'));
    expect(update.routing?.confidence).toBe(1);
  });

  it('drops intent when messageType is not action', async () => {
    const llm = makeProvider('{"messageType":"greeting","intent":"schedule","confidence":0.9}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('hola'));
    expect(update.routing?.messageType).toBe('greeting');
    expect(update.routing?.intent).toBeUndefined();
  });

  it('returns fail-open without calling LLM when input is empty', async () => {
    const create = vi.fn(async () => makeStubMessage('unused'));
    const client: AnthropicMessagesLike = { create };
    const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('   '));
    expect(create).not.toHaveBeenCalled();
    expect(update.routing?.messageType).toBe('action');
    expect(update.routing?.intent).toBe('unknown');
  });

  // ==========================================================================
  // Takeover capa A / C (spec P-human-takeover)
  // ==========================================================================

  it('capa A: classifies human_request when humanRequestEnabled + sets explicit_request reason', async () => {
    const llm = makeProvider('{"messageType":"human_request","confidence":0.92}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger, humanRequestEnabled: true });
    const update = await node(makeState('quiero hablar con una persona de verdad'));
    expect(update.routing?.messageType).toBe('human_request');
    expect(update.routing?.takeoverReason).toBe('explicit_request');
  });

  it('capa A: rejects human_request when the flag is OFF (normalizes to action/unknown)', async () => {
    const llm = makeProvider('{"messageType":"human_request","confidence":0.92}');
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    const update = await node(makeState('quiero hablar con alguien'));
    expect(update.routing?.messageType).toBe('action');
    expect(update.routing?.takeoverReason).toBeUndefined();
  });

  it('capa C: short-circuits to human_request when the frustration judge fires (no classify call)', async () => {
    const create = vi.fn(async () => makeStubMessage('unused'));
    const client: AnthropicMessagesLike = { create };
    const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
    const node = makeClassifyIntentNode({
      llm,
      logger: mockLogger,
      humanRequestEnabled: true,
      frustrationJudge: vi.fn().mockResolvedValue(true),
    });
    const update = await node(makeState('son un desastre, no sirve para nada'));
    expect(update.routing?.messageType).toBe('human_request');
    expect(update.routing?.takeoverReason).toBe('sentiment_frustration');
    // No gastó la call de clasificación.
    expect(create).not.toHaveBeenCalled();
  });

  it('capa C: proceeds to normal classify when the judge does NOT fire', async () => {
    const llm = makeProvider('{"messageType":"greeting","confidence":0.9}');
    const node = makeClassifyIntentNode({
      llm,
      logger: mockLogger,
      humanRequestEnabled: true,
      frustrationJudge: vi.fn().mockResolvedValue(false),
    });
    const update = await node(makeState('hola buenas'));
    expect(update.routing?.messageType).toBe('greeting');
  });
});

describe('classifyIntent role-aware staff hint (Nivel B, H9.2)', () => {
  function makeProviderWithSpy(): { llm: AnthropicProvider; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn(async () => makeStubMessage('{"messageType":"query","confidence":0.9}'));
    const client: AnthropicMessagesLike = { create };
    return {
      llm: new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client }),
      create,
    };
  }

  function stateWithProfile(text: string, profileType: 'client' | 'staff'): GraphState {
    const base = makeState(text);
    return { ...base, identity: { ...IDENTITY, profileType } };
  }

  it('inyecta el hint de plataforma cuando el usuario es staff', async () => {
    const { llm, create } = makeProviderWithSpy();
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    await node(stateWithProfile('cómo configuro mis horarios', 'staff'));
    const sys = (create.mock.calls[0]?.[0] as { system?: string }).system ?? '';
    expect(sys).toMatch(/PLATAFORMA/);
    expect(sys).toMatch(/CONFIGURAR/);
  });

  it('NO inyecta el hint cuando el usuario es client', async () => {
    const { llm, create } = makeProviderWithSpy();
    const node = makeClassifyIntentNode({ llm, logger: mockLogger });
    await node(stateWithProfile('cómo configuro mis horarios', 'client'));
    const sys = (create.mock.calls[0]?.[0] as { system?: string }).system ?? '';
    expect(sys).not.toMatch(/El usuario es STAFF del negocio/);
  });
});
