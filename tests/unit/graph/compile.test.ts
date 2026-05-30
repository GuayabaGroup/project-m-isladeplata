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
  roleId: 1, // owner — habilita tools owner-only (connect_mercado_pago)
};

function makeMessage(
  contentText: string,
  interactivePayload: InteractivePayload | null = null,
): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: `wamid.${Math.random()}`,
    contentType: interactivePayload ? 'interactive' : 'text',
    contentText,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
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

function makeGuacuco(overrides?: Partial<Record<keyof GuacucoClient, unknown>>): {
  guacuco: GuacucoClient;
  retrieveManzanilloUrl: ReturnType<typeof vi.fn>;
  connectMercadoPago: ReturnType<typeof vi.fn>;
} {
  const retrieveManzanilloUrl = vi.fn(
    (overrides?.retrieveManzanilloUrl as GuacucoClient['retrieveManzanilloUrl']) ??
      (async () => ({})),
  );
  const connectMercadoPago = vi.fn(
    (overrides?.connectMercadoPago as GuacucoClient['connectMercadoPago']) ?? (async () => ({})),
  );
  const guacuco = { retrieveManzanilloUrl, connectMercadoPago } as unknown as GuacucoClient;
  return { guacuco, retrieveManzanilloUrl, connectMercadoPago };
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
    const { guacuco, retrieveManzanilloUrl, connectMercadoPago } = makeGuacuco();
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
    expect(retrieveManzanilloUrl).not.toHaveBeenCalled();
    expect(connectMercadoPago).not.toHaveBeenCalled();
  });

  it('client "quiero el link" → retrieve_manzanillo_url tool', async () => {
    const { llm } = makeLlmStub('{"messageType":"action","intent":"unknown","confidence":0.6}');
    const { guacuco, retrieveManzanilloUrl } = makeGuacuco({
      retrieveManzanilloUrl: async () => ({ url: 'https://manzanillo.app/abc' }),
    });
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
    expect(retrieveManzanilloUrl).toHaveBeenCalledWith(IDENTITY_CLIENT);
  });

  it('staff "conectar mercadopago" → connect_mercado_pago tool', async () => {
    const { llm } = makeLlmStub('{"messageType":"action","intent":"unknown","confidence":0.6}');
    const { guacuco, connectMercadoPago } = makeGuacuco({
      connectMercadoPago: async () => ({ url: 'https://mp.example/connect' }),
    });
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
    expect(connectMercadoPago).toHaveBeenCalledWith(IDENTITY_STAFF);
  });

  it('client "quiero agendar" with empty catalog terminates with actionable message (no loop)', async () => {
    // 2 LLM calls expected: classifier (intent=schedule), schedule_entry (entity extraction).
    const { llm } = makeMultiReplyLlm([
      '{"messageType":"action","intent":"schedule","confidence":0.9}',
      '{}', // entry extracts nothing actionable from this short prompt
    ]);
    const { guacuco, retrieveManzanilloUrl, connectMercadoPago } = makeGuacuco();
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

    // Sin catalog (negocio sin servicios agendables) → resolveEntities corta el
    // loop con un mensaje accionable en vez de preguntar servicio indefinidamente.
    const interrupts = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__;
    expect(interrupts).toBeUndefined();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no hay servicios disponibles/i);
    expect(retrieveManzanilloUrl).not.toHaveBeenCalled();
    expect(connectMercadoPago).not.toHaveBeenCalled();
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

    // Botón stale/huérfano (confirm:<uuid> sin subgrafo activo): NO escala a
    // humano — responde invitando a reformular y resetea el contador de fallas.
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/ya no está disponible/i);
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

  it('media content short-circuits with a canned reply without calling the LLM', async () => {
    const { llm, create } = makeLlmStub('unused');
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });

    const result = await graph.invoke(
      {
        input: {
          channelMessage: { ...makeMessage(''), contentType: 'image' },
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'th-image' } },
    );

    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/solo puedo procesar mensajes de texto/i);
    expect(create).not.toHaveBeenCalled();
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

  it('second turn on same thread does NOT re-emit the previous turn outcome (stale checkpoint)', async () => {
    // Regresión: `outcome` es un canal persistido en el checkpoint. En el invoke
    // fresh del 2º turno conservaba el outcome del 1º; `supervisorEntryRouter` lo
    // confundía con el fast-path de media y cortocircuitaba a END re-emitiendo el
    // saludo byte-por-byte. El reset en `supervisorEntryNode` lo corrige.
    const { llm, create } = makeMultiReplyLlm([
      '{"messageType":"greeting","confidence":0.95}', // turno 1: classifier
      '¡Hola! Soy Groomy, ¿en qué te ayudo?', // turno 1: social
      '{"messageType":"query","confidence":0.95}', // turno 2: classifier (≠ greeting)
      'Tenés 3 turnos esta semana.', // turno 2: query synthesize
    ]);
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });
    const threadId = 'th-two-turns';

    const turn1 = await graph.invoke(
      {
        input: { channelMessage: makeMessage('Hola'), receivedAt: new Date().toISOString() },
        identity: IDENTITY_STAFF,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: threadId } },
    );
    expect(turn1.outcome?.action).toBe('response');
    expect(turn1.outcome?.pendingReply?.text).toContain('Hola');
    const callsAfterTurn1 = create.mock.calls.length;

    const turn2 = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('Cuantos turnos tengo esta semana?'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_STAFF,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: threadId } },
    );

    // El 2º turno NO debe re-emitir el saludo del 1º.
    expect(turn2.outcome?.pendingReply?.text).not.toBe(turn1.outcome?.pendingReply?.text);
    // Y el classifier DEBE haber corrido en el 2º turno (no se cortocircuitó a END).
    expect(create.mock.calls.length).toBeGreaterThan(callsAfterTurn1);
  });

  it('stale buttonShortcut from a prior button tap does NOT hijack the next free-text turn', async () => {
    // Regresión: `routing` es un canal persistido + mergeado en el checkpoint.
    // Un `buttonShortcut` seteado por un tap previo (turno 1) sobrevivía al turno
    // siguiente; `supervisorEntryRouter`/`routeFromSupervisor` lo leían y desviaban
    // el texto libre a `subgraph_placeholder` → "Esa opción ya no está disponible",
    // sin correr el classifier. El reset per-turno en `supervisorEntryNode` lo corrige.
    const { llm, create } = makeMultiReplyLlm([
      '{"messageType":"greeting","confidence":0.95}', // turno 2: classifier
      '¡Hola de nuevo! ¿En qué te ayudo?', // turno 2: social
    ]);
    const { guacuco } = makeGuacuco();
    const graph = compileGraph({ checkpointer, logger: mockLogger, llm, guacuco });
    const threadId = 'th-stale-shortcut';

    // Turno 1: tap de botón confirm:<uuid> sin subgrafo activo → placeholder, sin LLM.
    // Setea routing.buttonShortcut, que queda persistido en el checkpoint.
    const turn1 = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('', { type: 'button', id: 'confirm:abc-123' }),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: threadId } },
    );
    expect(turn1.outcome?.pendingReply?.text).toMatch(/ya no está disponible/i);
    expect(create).not.toHaveBeenCalled(); // turno 1 bypaseó el LLM

    // Turno 2: texto libre. NO debe heredar el buttonShortcut del turno 1.
    const turn2 = await graph.invoke(
      {
        input: {
          channelMessage: makeMessage('hola, una consulta'),
          receivedAt: new Date().toISOString(),
        },
        identity: IDENTITY_CLIENT,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: threadId } },
    );

    // El texto libre NO cae en el placeholder de botón stale…
    expect(turn2.outcome?.pendingReply?.text).not.toMatch(/ya no está disponible/i);
    expect(turn2.outcome?.pendingReply?.text).toContain('Hola');
    // …y el classifier DEBE haber corrido (no se cortocircuitó por el shortcut stale).
    expect(create).toHaveBeenCalled();
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
