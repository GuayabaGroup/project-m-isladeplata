/**
 * Tests E2E del subgrafo reschedule a través del parent graph.
 * Verifica wire en compile.ts: classifier → dispatch → bootstrap → ask/validate
 * → present/build_confirm → gate → commit → success → finalize → outcome global.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Command, MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../src/clients/GuacucoClient.js';
import type {
  RescheduleAppointmentResult,
  ValidateRescheduleSlotResult,
} from '../../../../src/clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../src/core/errors/ToolExecutionError.js';
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
    contentType: interactivePayload ? 'interactive' : 'text',
    contentText,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
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

function defaultSuccess(): RescheduleAppointmentResult {
  return {
    response_type: 'text',
    message: 'ok',
    appointment_uuid: 'apt-1',
    business_uuid: 'biz-1',
    client_uuid: 'profile-client',
    appointment_date: '2026-06-05',
    start_time: '14:00',
    end_time: '15:00',
    status: 1,
    staff_assignments: [],
  };
}

function validatePassed(): ValidateRescheduleSlotResult {
  return {
    passed: true,
    proposed_slots: [{ date: '2026-06-05', time: '14:00' }],
    appointment_uuid: 'apt-1',
    service_duration_minutes: 60,
  };
}

function makeGuacuco(opts: {
  validate?: () => Promise<ValidateRescheduleSlotResult>;
  reschedule?: (p: unknown, o?: unknown) => Promise<RescheduleAppointmentResult>;
}): {
  guacuco: GuacucoClient;
  calls: {
    validate: ReturnType<typeof vi.fn>;
    reschedule: ReturnType<typeof vi.fn>;
  };
} {
  const validate = vi.fn(opts.validate ?? validatePassed);
  const reschedule = vi.fn(opts.reschedule ?? defaultSuccess);
  return {
    guacuco: {
      validateRescheduleSlot: validate,
      rescheduleAppointment: reschedule,
    } as unknown as GuacucoClient,
    calls: { validate, reschedule },
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

function extractIntentUuid(payload: ReturnType<typeof getInterrupt>): string | undefined {
  const id = payload?.pendingReply?.buttons?.find((b) => b.id.startsWith('confirm:'))?.id;
  return id?.slice('confirm:'.length);
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// #1: 0 upcomings → response amable, no Guacuco
// ============================================================================

describe('reschedule E2E #1: 0 upcomings → response amable', () => {
  it('no llama validate ni reschedule, outcome=response', async () => {
    const llm = makeSeqLlm(['{"messageType":"action","intent":"reschedule","confidence":0.95}']);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const result = await graph.invoke(freshInvoke(makeMessage('reagendar mi turno'), CRM_ZERO), {
      configurable: { thread_id: 'e2e-r-1' },
    });
    expect(calls.validate).not.toHaveBeenCalled();
    expect(calls.reschedule).not.toHaveBeenCalled();
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toMatch(/no ten[ée]s turnos/i);
  });
});

// ============================================================================
// #2: 1 upcoming + nuevo slot disponible (exact match)
// ============================================================================

describe('reschedule E2E #2: 1 upcoming + slot disponible', () => {
  it('bootstrap pre-fill apt → ask date/time → validate exact → gate → commit', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Corte al jueves 5 de junio a las 14:00?', // buildConfirm
      '¡Reagendado al 5 de junio a las 14:00!', // success
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-2' } };

    // Turno 1: bootstrap pre-fillea apt-1 → ask date/time
    const first = await graph.invoke(
      freshInvoke(makeMessage('reagendar mi turno'), CRM_ONE),
      config,
    );
    expect(getInterrupt(first)?.pendingReply?.text).toMatch(/cuándo|día/i);

    // Turno 2: usuario manda "2026-06-05 a las 14:00"
    const second = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    // validate corre → exact match → buildConfirm → gate
    expect(calls.validate).toHaveBeenCalledOnce();
    const gateInterrupt = getInterrupt(second);
    expect(gateInterrupt?.pendingReply?.buttons).toBeDefined();
    const intentUuid = extractIntentUuid(gateInterrupt);
    expect(intentUuid).toBeDefined();

    // Turno 3: tapea Sí, reagendar
    const third = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid}` } }),
      config,
    );
    expect(calls.reschedule).toHaveBeenCalledOnce();
    expect(calls.reschedule).toHaveBeenCalledWith(
      { appointment_uuid: 'apt-1', new_date: '2026-06-05', new_time: '14:00' },
      IDENTITY,
      expect.objectContaining({ idempotencyKey: intentUuid }),
    );
    expect(third.outcome?.action).toBe('response');
  });
});

// ============================================================================
// #3: N upcomings → ask cuál + ask date/time → commit
// ============================================================================

describe('reschedule E2E #3: N upcomings → ask cuál → ask date/time → commit', () => {
  it('lista turnos, pick apt-2, manda date/time, valida, gate, commit', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Color al jueves 5 de junio a las 14:00?', // buildConfirm
      '¡Reagendado!', // success
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-3' } };

    // Turno 1: bootstrap detecta 2 upcomings → ask cuál (list)
    const first = await graph.invoke(
      freshInvoke(makeMessage('reagendar un turno'), CRM_TWO),
      config,
    );
    expect(getInterrupt(first)?.pendingReply?.list).toBeDefined();

    // Turno 2: pick apt-2 → ask date/time
    const second = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:apt-2' } }),
      config,
    );
    expect(getInterrupt(second)?.pendingReply?.text).toMatch(/cuándo|día/i);

    // Turno 3: date/time → validate exact → gate
    const third = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    const intentUuid = extractIntentUuid(getInterrupt(third));
    expect(intentUuid).toBeDefined();

    // Turno 4: confirm → commit
    const fourth = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid}` } }),
      config,
    );
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ appointment_uuid: 'apt-2' }),
      IDENTITY,
      expect.any(Object),
    );
    expect(fourth.outcome?.action).toBe('response');
  });
});

// ============================================================================
// #4: validate passed=false con sugerencias → present_options → pick → commit
// ============================================================================

describe('reschedule E2E #4: slot ocupado → present_options → user pick → commit', () => {
  it('validate falla, presenta sugerencias, pick → commit con date/time del pick', async () => {
    let validateCount = 0;
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Corte al jueves 5 de junio a las 15:00?', // buildConfirm (con el pick)
      '¡Reagendado!', // success
    ]);
    const { guacuco, calls } = makeGuacuco({
      validate: async () => {
        validateCount++;
        return {
          passed: false,
          proposed_slots: [
            { date: '2026-06-05', time: '15:00' },
            { date: '2026-06-05', time: '16:00' },
          ],
          appointment_uuid: 'apt-1',
          service_duration_minutes: 60,
        };
      },
    });
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-4' } };

    // Turno 1: bootstrap pre-fill → ask date/time
    const first = await graph.invoke(
      freshInvoke(makeMessage('reagendar mi turno'), CRM_ONE),
      config,
    );
    expect(getInterrupt(first)?.pendingReply?.text).toMatch(/cuándo|día/i);

    // Turno 2: date/time → validate falla → present
    const second = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    expect(validateCount).toBe(1);
    expect(getInterrupt(second)?.pendingReply?.list).toBeDefined();

    // Turno 3: pick slot_pick:1 (16:00) → buildConfirm → gate
    const third = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'slot_pick:1' } }),
      config,
    );
    const intentUuid = extractIntentUuid(getInterrupt(third));
    expect(intentUuid).toBeDefined();

    // Turno 4: confirm → commit con 16:00
    const fourth = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid}` } }),
      config,
    );
    expect(calls.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        appointment_uuid: 'apt-1',
        new_date: '2026-06-05',
        new_time: '16:00',
      }),
      IDENTITY,
      expect.any(Object),
    );
    expect(fourth.outcome?.action).toBe('response');
  });
});

// ============================================================================
// #5: race en commit (STAFF_NOT_AVAILABLE) → recovery → re-validate
// ============================================================================

describe('reschedule E2E #5: race en commit → re-validate', () => {
  it('1er commit lanza race → re-validate sugiere → pick → 2do commit OK', async () => {
    let validateCount = 0;
    let rescheduleCount = 0;
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Corte (original)?',
      '¿Reagendo Corte (sugerencia)?',
      '¡Reagendado!',
    ]);
    const { guacuco, calls } = makeGuacuco({
      validate: async () => {
        validateCount++;
        if (validateCount === 1) return validatePassed();
        // Post-race: pasa sugerencias
        return {
          passed: false,
          proposed_slots: [{ date: '2026-06-05', time: '17:00' }],
          appointment_uuid: 'apt-1',
          service_duration_minutes: 60,
        };
      },
      reschedule: async () => {
        rescheduleCount++;
        if (rescheduleCount === 1) throw new ToolExecutionError('STAFF_NOT_AVAILABLE', 'race');
        return defaultSuccess();
      },
    });
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-5' } };

    // Turno 1: bootstrap → ask
    const first = await graph.invoke(
      freshInvoke(makeMessage('reagendar mi turno'), CRM_ONE),
      config,
    );
    expect(getInterrupt(first)?.pendingReply?.text).toMatch(/cuándo|día/i);

    // Turno 2: date/time → validate exact → gate
    const second = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    const intentUuid1 = extractIntentUuid(getInterrupt(second));

    // Turno 3: confirm → commit lanza race → re-validate → present_options
    const third = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid1}` } }),
      config,
    );
    expect(validateCount).toBe(2);
    expect(getInterrupt(third)?.pendingReply?.list).toBeDefined();

    // Turno 4: pick → buildConfirm → gate
    const fourth = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'slot_pick:0' } }),
      config,
    );
    const intentUuid2 = extractIntentUuid(getInterrupt(fourth));

    // Turno 5: confirm → commit OK
    const fifth = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid2}` } }),
      config,
    );
    expect(calls.reschedule).toHaveBeenCalledTimes(2);
    expect(fifth.outcome?.action).toBe('response');
  });
});

// ============================================================================
// #6: cancel del gate → vuelve a collecting, slots preservados
// ============================================================================

describe('reschedule E2E #6: cancel del gate → no commit', () => {
  it('user tapea No → no llama reschedule, vuelve a ask_slot', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Corte?',
    ]);
    const { guacuco, calls } = makeGuacuco({});
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-6' } };

    const first = await graph.invoke(
      freshInvoke(makeMessage('reagendar mi turno'), CRM_ONE),
      config,
    );
    expect(getInterrupt(first)?.pendingReply?.text).toMatch(/cuándo|día/i);

    const second = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    const intentUuid = extractIntentUuid(getInterrupt(second));
    expect(intentUuid).toBeDefined();

    // Tapea No → cancela gate → vuelve a ask (no commit)
    const third = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `cancel:${intentUuid}` } }),
      config,
    );
    expect(calls.reschedule).not.toHaveBeenCalled();
    // El graph se interrumpió de nuevo en ask_slot (slots cleared back to collecting)
    expect(getInterrupt(third)?.pendingReply).toBeDefined();
  });
});

// ============================================================================
// #7: anti-alucinación — APPOINTMENT_NOT_FOUND → error terminal
// ============================================================================

describe('reschedule E2E #7: APPOINTMENT_NOT_FOUND → error terminal', () => {
  it('Guacuco devuelve NOT_FOUND en commit → outcome=error con texto explicativo', async () => {
    const llm = makeSeqLlm([
      '{"messageType":"action","intent":"reschedule","confidence":0.95}',
      '¿Reagendo Corte?',
    ]);
    const { guacuco } = makeGuacuco({
      reschedule: async () => {
        throw new ToolExecutionError('APPOINTMENT_NOT_FOUND', '');
      },
    });
    const graph = compileGraph({
      checkpointer: new MemorySaver(),
      logger: mockLogger,
      llm,
      guacuco,
    });
    const config = { configurable: { thread_id: 'e2e-r-7' } };

    await graph.invoke(freshInvoke(makeMessage('reagendar mi turno'), CRM_ONE), config);
    const second = await graph.invoke(
      new Command({ resume: { text: '2026-06-05 a las 14:00' } }),
      config,
    );
    const intentUuid = extractIntentUuid(getInterrupt(second));
    const third = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${intentUuid}` } }),
      config,
    );
    expect(third.outcome?.action).toBe('error');
    expect(third.outcome?.pendingReply?.text).toMatch(/no encontré/i);
  });
});
