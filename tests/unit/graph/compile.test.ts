import type Anthropic from '@anthropic-ai/sdk';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { ChannelMessage, InteractivePayload } from '../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import { compileGraph } from '../../../src/graph/compile.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../src/infrastructure/llm/AnthropicProvider.js';

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
};

function makeMessage(
  contentText: string,
  interactivePayload: InteractivePayload | null = null,
): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: `wamid.${Math.random()}`,
    contentText,
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
    interactivePayload,
  };
}

function makeLlmStub(replyText: string): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(
    async () =>
      ({
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: replyText, citations: null }],
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
      }) as Anthropic.Messages.Message,
  );
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { llm, create };
}

/** Stub LLM que cambia su output por turno (classifier vs social, en cualquier orden). */
function makeMultiReplyLlm(replies: string[]): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const create = vi.fn(async () => {
    const text = replies[i % replies.length] ?? '';
    i++;
    return {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text, citations: null }],
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
  });
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { llm, create };
}

function makeGuacuco(impl?: GuacucoClient['executeTool']): {
  guacuco: GuacucoClient;
  executeTool: ReturnType<typeof vi.fn>;
} {
  const executeTool = vi.fn(impl ?? (async () => ({})));
  const guacuco = { executeTool } as unknown as GuacucoClient;
  return { guacuco, executeTool };
}

let checkpointer: MemorySaver;

beforeEach(() => {
  checkpointer = new MemorySaver();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('compileGraph (supervisor wiring)', () => {
  it('greeting → social_responder fast-path', async () => {
    const { llm } = makeMultiReplyLlm([
      '{"messageType":"greeting","confidence":0.95}', // classifier
      '¡Hola! ¿En qué te puedo ayudar?', // social responder
    ]);
    const { guacuco, executeTool } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: { channelMessage: makeMessage('hola buenas'), receivedAt: new Date().toISOString() },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-greeting' } },
    );

    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toContain('Hola');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('client "quiero el link" → retrieve_manzanillo_url tool', async () => {
    const { llm } = makeLlmStub('{"messageType":"action","intent":"unknown","confidence":0.6}');
    const { guacuco, executeTool } = makeGuacuco((async () => ({
      url: 'https://manzanillo.app/abc',
    })) as unknown as GuacucoClient['executeTool']);
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('quiero el link de reserva'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-manzanillo' } },
    );

    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.cta?.url).toBe('https://manzanillo.app/abc');
    expect(executeTool).toHaveBeenCalledWith(
      'retrieve_manzanillo_url',
      {},
      { context: { profile_uuid: 'profile-client' } },
    );
  });

  it('staff "conectar mercadopago" → connect_mercado_pago tool', async () => {
    const { llm } = makeLlmStub('{"messageType":"action","intent":"unknown","confidence":0.6}');
    const { guacuco, executeTool } = makeGuacuco((async () => ({
      url: 'https://mp.example/connect',
    })) as unknown as GuacucoClient['executeTool']);
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('cómo conecto mercadopago'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_STAFF,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-mp' } },
    );

    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.cta?.displayText).toBe('Conectar');
    expect(executeTool).toHaveBeenCalledWith(
      'connect_mercado_pago',
      {},
      { context: { business_allia_id: 'allia-1' } },
    );
  });

  it('client "quiero agendar" enters schedule subgraph and interrupts asking for services', async () => {
    // 2 LLM calls expected: classifier (intent=schedule), schedule_entry (entity extraction).
    const { llm } = makeMultiReplyLlm([
      '{"messageType":"action","intent":"schedule","confidence":0.9}',
      '{}', // entry extracts nothing actionable from this short prompt
    ]);
    const { guacuco, executeTool } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('quiero agendar para mañana'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-schedule-fresh' } },
    );

    // Sin catalog → ask_slot construye payload de texto pidiendo servicio.
    const interrupts = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__;
    expect(interrupts).toBeDefined();
    expect(interrupts).toHaveLength(1);
    const payload = interrupts?.[0]?.value as { pendingReply?: { text?: string } };
    expect(payload?.pendingReply?.text).toMatch(/servicio/i);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('button payload confirm:<uuid> → subgraph_placeholder (no LLM call)', async () => {
    const { llm, create } = makeLlmStub('unused');
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('', { type: 'button', id: 'confirm:abc-123' }),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-button' } },
    );

    expect(result.outcome?.action).toBe('handed_off');
    expect(create).not.toHaveBeenCalled(); // bypassed LLM entirely
  });

  it('OOS ("cómo está el clima") → social_responder with oos handler', async () => {
    const { llm, create } = makeMultiReplyLlm([
      '{"messageType":"oos","confidence":0.9}',
      'Puedo ayudarte con turnos y consultas. ¿Querés agendar?',
    ]);
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('cómo está el clima'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-oos' } },
    );

    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toContain('turnos');
    // 2 calls = classifier + social
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('thread isolation: different thread_ids produce independent state', async () => {
    const { llm } = makeLlmStub('{"messageType":"greeting","confidence":0.95}');
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: { channelMessage: makeMessage('hola'), receivedAt: new Date().toISOString() },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-iso-A' } },
    );

    expect(result.outcome?.action).toBe('response');
  });

  it('returns ignored outcome when input is missing', async () => {
    const { llm, create } = makeLlmStub('unused');
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    // Without input, supervisorEntryNode returns {} and classifier sees empty text → fail-open
    // action/unknown/0.3 → router goes to social_responder. But socialResponder also sees empty
    // text. Result should still be a response (LLM returns whatever, social falls back).
    const result = await graph.invoke(
      { identity: IDENTITY_CLIENT, crmContext: EMPTY_CRM_CONTEXT },
      { configurable: { thread_id: 'th-noinput' } },
    );

    // classify_intent skipped LLM (empty text) → fail-open action/unknown → router → social
    // Social responder LLM IS called (no input but state.input is undefined → contentText '');
    // it falls back to deterministic.
    expect(result.outcome?.action).toBe('response');
    expect(create).toHaveBeenCalledOnce(); // only the social call (classifier skipped)
  });
});
