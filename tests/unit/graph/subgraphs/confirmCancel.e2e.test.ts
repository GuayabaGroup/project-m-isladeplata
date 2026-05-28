/**
 * Tests E2E de los subgrafos confirm + cancel a través del parent graph.
 * Verifican que el wire en compile.ts funciona end-to-end (classifier →
 * dispatch → bootstrap → ... → finalize → outcome global).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Command, MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../src/clients/GuacucoClient.js';
import type {
  CancelAppointmentResult,
  ConfirmAppointmentResult,
} from '../../../../src/clients/types/GuacucoTypes.js';
import { EMPTY_CATALOG } from '../../../../src/core/types/Catalog.js';
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

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-client',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
  tenantName: 'Estética Norte',
};

function makeMessage(
  contentText: string,
  interactivePayload: InteractivePayload | null = null,
): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: `wamid.${Math.random().toString(36).slice(2)}`,
    contentText,
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
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
  const create = vi.fn(async () => {
    const text = replies[i] ?? '';
    i++;
    return stub(text);
  });
  const client: AnthropicMessagesLike = { create };
  return new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
}

function makeGuacuco(opts: {
  confirm?: (p: unknown, o?: unknown) => Promise<ConfirmAppointmentResult>;
  cancel?: (p: unknown, o?: unknown) => Promise<CancelAppointmentResult>;
}): {
  guacuco: GuacucoClient;
  calls: { confirm: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
} {
  const confirm = vi.fn(
    opts.confirm ??
      (async () =>
        ({
          response_type: 'text',
          message: 'ok',
          appointment_uuid: 'apt-1',
          status: 1,
        }) as ConfirmAppointmentResult),
  );
  const cancel = vi.fn(
    opts.cancel ??
      (async () =>
        ({
          response_type: 'text',
          message: 'ok',
          appointment_uuid: 'apt-1',
          status: 0,
        }) as CancelAppointmentResult),
  );
  return {
    guacuco: {
      confirmAppointment: confirm,
      cancelAppointment: cancel,
    } as unknown as GuacucoClient,
    calls: { confirm, cancel },
  };
}

const CRM_ONE: CrmContext = {
  upcomingAppointments: [
    { appointmentUuid: 'apt-1', description: 'Corte mañana 16:00', startAt: '2026-05-28T16:00' },
  ],
  profileMeta: {},
};

const CRM_TWO: CrmContext = {
  upcomingAppointments: [
    { appointmentUuid: 'apt-1', description: 'Corte mañana 16:00', startAt: '2026-05-28T16:00' },
    { appointmentUuid: 'apt-2', description: 'Color viernes 10:00', startAt: '2026-06-04T10:00' },
  ],
  profileMeta: {},
};

const CRM_ZERO: CrmContext = { upcomingAppointments: [], profileMeta: {} };

function freshInvoke(message: ChannelMessage, crm: CrmContext) {
  return {
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: IDENTITY,
    crmContext: crm,
    catalog: EMPTY_CATALOG,
  };
}

function getInterrupt(result: { __interrupt__?: Array<{ value: unknown }> }) {
  return result.__interrupt__?.[0]?.value as
    | { pendingReply?: { text?: string; buttons?: Array<{ id: string }>; list?: unknown } }
    | undefined;
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// confirm E2E
// ============================================================================

describe('confirm E2E #1: 1 upcoming → auto-commit + success', () => {
  it('user dice "confirmar" → auto-commit del único → response', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"confirm","confidence":0.95}',
      'Listo, confirmé Corte mañana 16:00. ¡Te esperamos!',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });

    const result = await graph.invoke(freshInvoke(makeMessage('confirmar mi turno'), CRM_ONE), {
      configurable: { thread_id: 'e2e-confirm-1' },
    });

    expect(calls.confirm).toHaveBeenCalledOnce();
    expect(calls.confirm).toHaveBeenCalledWith(
      { appointment_uuid: 'apt-1' },
      IDENTITY,
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(result.outcome?.action).toBe('response');
  });
});

describe('confirm E2E #2: 0 upcomings → response amable, no Guacuco', () => {
  it('no llama confirm, devuelve outcome=response con texto explicativo', async () => {
    const llm = makeSeqLlm(['{"messageType":"action","intent":"confirm","confidence":0.95}']);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });

    const result = await graph.invoke(freshInvoke(makeMessage('confirmar'), CRM_ZERO), {
      configurable: { thread_id: 'e2e-confirm-2' },
    });

    expect(calls.confirm).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no ten[ée]s turnos/i);
  });
});

describe('confirm E2E #3: N upcomings → ask → pick → commit', () => {
  it('lista turnos, usuario pica → commit del elegido', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"confirm","confidence":0.95}',
      'Listo, confirmé Color viernes 10:00.',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-confirm-3' } };

    const first = await graph.invoke(freshInvoke(makeMessage('confirmar'), CRM_TWO), config);
    expect(getInterrupt(first)?.pendingReply).toBeDefined();

    const final = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:apt-2' } }),
      config,
    );
    expect(calls.confirm).toHaveBeenCalledWith(
      { appointment_uuid: 'apt-2' },
      IDENTITY,
      expect.any(Object),
    );
    expect(final.outcome?.action).toBe('response');
  });
});

// ============================================================================
// cancel E2E
// ============================================================================

describe('cancel E2E #1: 1 upcoming → gate → confirm button → commit', () => {
  it('flujo completo: bootstrap pre-fill → gate → confirm → commit + success', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"cancel","confidence":0.95}',
      '¿Cancelo Corte mañana 16:00?', // buildConfirmMessage
      'Cancelado. Si querés reprogramar, decímelo.', // success
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-cancel-1' } };

    const first = await graph.invoke(
      freshInvoke(makeMessage('cancelar mi turno'), CRM_ONE),
      config,
    );
    const interrupt1 = getInterrupt(first);
    expect(interrupt1?.pendingReply?.buttons).toBeDefined();
    const uuid = interrupt1?.pendingReply?.buttons?.[0]?.id.slice('confirm:'.length);
    expect(uuid).toBeDefined();

    const final = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${uuid}` } }),
      config,
    );
    expect(calls.cancel).toHaveBeenCalledOnce();
    expect(calls.cancel).toHaveBeenCalledWith(
      { appointment_uuid: 'apt-1' },
      IDENTITY,
      expect.objectContaining({ idempotencyKey: uuid }),
    );
    expect(final.outcome?.action).toBe('response');
  });
});

describe('cancel E2E #2: gate cancel button → no commit, vuelve a collecting', () => {
  it('usuario tapea Cancel (no) en el gate → no se ejecuta cancel', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"cancel","confidence":0.95}',
      '¿Cancelo Corte mañana 16:00?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-cancel-2' } };

    const first = await graph.invoke(freshInvoke(makeMessage('cancelar'), CRM_ONE), config);
    const uuid = getInterrupt(first)?.pendingReply?.buttons?.[1]?.id.slice('cancel:'.length);

    const second = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `cancel:${uuid}` } }),
      config,
    );
    // Volvió a collecting → ask_slot interrumpe pidiendo cuál cancelar
    expect(calls.cancel).not.toHaveBeenCalled();
    expect(getInterrupt(second)?.pendingReply).toBeDefined();
  });
});

describe('cancel E2E #3: 0 upcomings → response amable', () => {
  it('sin turnos próximos → outcome=response, no llama cancel', async () => {
    const llm = makeSeqLlm(['{"messageType":"action","intent":"cancel","confidence":0.95}']);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });

    const result = await graph.invoke(freshInvoke(makeMessage('cancelar'), CRM_ZERO), {
      configurable: { thread_id: 'e2e-cancel-3' },
    });

    expect(calls.cancel).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no ten[ée]s turnos/i);
  });
});

describe('cancel E2E #4: stale uuid en gate → no confirma', () => {
  it('tap con uuid de otro gate → tratado como cancel implícito, no se ejecuta cancel', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"cancel","confidence":0.95}',
      '¿Cancelo?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-cancel-4' } };

    await graph.invoke(freshInvoke(makeMessage('cancelar'), CRM_ONE), config);
    const second = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'confirm:STALE-UUID' } }),
      config,
    );
    expect(calls.cancel).not.toHaveBeenCalled();
    // Volvió a collecting + ask_slot interrumpe
    expect(getInterrupt(second)?.pendingReply).toBeDefined();
  });
});
