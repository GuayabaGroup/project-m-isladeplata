import type Anthropic from '@anthropic-ai/sdk';
import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { CancelAppointmentResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import { IdpError } from '../../../../../src/core/errors/IdpError.js';
import { ToolExecutionError } from '../../../../../src/core/errors/ToolExecutionError.js';
import type { CrmContext } from '../../../../../src/core/types/CrmContext.js';
import { makeCancelAskSlotNode } from '../../../../../src/graph/subgraphs/cancel/nodes/askSlot.js';
import { makeCancelBootstrapNode } from '../../../../../src/graph/subgraphs/cancel/nodes/bootstrap.js';
import { makeCancelBuildConfirmMessageNode } from '../../../../../src/graph/subgraphs/cancel/nodes/buildConfirmMessage.js';
import { makeCancelCommitNode } from '../../../../../src/graph/subgraphs/cancel/nodes/commit.js';
import { makeCancelGateConfirmNode } from '../../../../../src/graph/subgraphs/cancel/nodes/gateConfirm.js';
import { makeCancelSuccessNode } from '../../../../../src/graph/subgraphs/cancel/nodes/successResponse.js';
import {
  type CancelDraftState,
  initialCancelDraftState,
} from '../../../../../src/graph/subgraphs/cancel/state.js';
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

function makeLlm(reply: string): { llm: AnthropicProvider; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => stub(reply));
  const client: AnthropicMessagesLike = { create };
  return {
    llm: new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client }),
    create,
  };
}

function crmWith(count: number): CrmContext {
  return {
    upcomingAppointments: Array.from({ length: count }, (_, i) => ({
      appointmentUuid: `apt-${i + 1}`,
      description: `Turno ${i + 1}`,
      startAt: `2026-05-${28 + i}T16:00`,
    })),
    profileMeta: {},
  };
}

function readyDraft(uuid = 'apt-1', displayName = 'Turno 1'): CancelDraftState {
  const d = initialCancelDraftState();
  d.slots.appointmentUuid = { value: uuid, displayName, status: 'resolved' };
  d.phase = 'awaiting_confirmation';
  return d;
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// bootstrap
// ============================================================================

describe('cancel.bootstrap', () => {
  it('0 upcomings → response amable, phase=failed', () => {
    const node = makeCancelBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(0), subgraphState: initialCancelDraftState() });
    expect(out.phase).toBe('failed');
    expect(out.terminalOutcome?.action).toBe('response');
    expect(out.terminalOutcome?.pendingReply?.text).toMatch(/no ten[ée]s turnos/i);
  });

  it('1 upcoming → pre-fill + phase=awaiting_confirmation (NO commit directo, requiere gate)', () => {
    const node = makeCancelBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(1), subgraphState: initialCancelDraftState() });
    expect(out.phase).toBe('awaiting_confirmation');
    expect(out.slots?.appointmentUuid?.value).toBe('apt-1');
  });

  it('2+ upcomings → phase=collecting', () => {
    const node = makeCancelBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(3), subgraphState: initialCancelDraftState() });
    expect(out.phase).toBe('collecting');
  });
});

// ============================================================================
// askSlot (interrupt + resume)
// ============================================================================

function buildAskHarness() {
  const Ann = Annotation.Root({
    crmContext: Annotation<CrmContext>({
      reducer: (_c, n) => n,
      default: () => ({ upcomingAppointments: [], profileMeta: {} }),
    }),
    subgraphState: Annotation<CancelDraftState>({
      reducer: (current, next) => ({
        ...current,
        ...next,
        slots: { ...current.slots, ...(next.slots ?? {}) },
        confirmation: next.confirmation !== undefined ? next.confirmation : current.confirmation,
        meta: {
          attempts: current.meta.attempts + (next.meta?.attempts ?? 0),
          recoverableErrors: [
            ...current.meta.recoverableErrors,
            ...(next.meta?.recoverableErrors ?? []),
          ],
        },
      }),
      default: () => initialCancelDraftState(),
    }),
  });
  const node = makeCancelAskSlotNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('ask', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new MemorySaver() });
}

describe('cancel.askSlot', () => {
  it('lista upcomings y al picar → resolve + phase=awaiting_confirmation (no commit)', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 't-cancel-ask' } };
    await graph.invoke(
      { crmContext: crmWith(2), subgraphState: initialCancelDraftState() },
      config,
    );
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:apt-2' } }),
      config,
    );
    expect(resumed.subgraphState.slots.appointmentUuid.value).toBe('apt-2');
    expect(resumed.subgraphState.phase).toBe('awaiting_confirmation');
  });

  it('body del list dice "cancelar"', async () => {
    const graph = buildAskHarness();
    const result = await graph.invoke(
      { crmContext: crmWith(2), subgraphState: initialCancelDraftState() },
      { configurable: { thread_id: 't-cancel-body' } },
    );
    const payload = result.__interrupt__[0].value as { pendingReply: { list?: { body: string } } };
    expect(payload.pendingReply.list?.body).toMatch(/cancelar/i);
  });
});

// ============================================================================
// buildConfirmMessage
// ============================================================================

describe('cancel.buildConfirmMessage', () => {
  it('genera mensaje + intentUuid en happy path', async () => {
    const { llm, create } = makeLlm('¿Cancelo Turno 1?');
    const node = makeCancelBuildConfirmMessageNode({ llm, logger: mockLogger });
    const out = await node({ subgraphState: readyDraft() });
    expect(out.confirmation?.intentUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.confirmation?.message).toBe('¿Cancelo Turno 1?');
    expect(create).toHaveBeenCalledOnce();
  });

  it('idempotente: si ya hay intentUuid + message → no-op', async () => {
    const draft = readyDraft();
    draft.confirmation = {
      intentUuid: 'existing',
      message: 'cached',
      requestedAt: '2026-05-27',
    };
    const { llm, create } = makeLlm('new');
    const node = makeCancelBuildConfirmMessageNode({ llm, logger: mockLogger });
    const out = await node({ subgraphState: draft });
    expect(create).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  it('user prompt incluye displayName (NO uuid)', async () => {
    const { llm, create } = makeLlm('ok');
    const node = makeCancelBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ subgraphState: readyDraft('apt-1', 'Corte con María 28 mayo') });
    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).toContain('Corte con María 28 mayo');
    expect(userMsg).not.toContain('apt-1');
  });

  it('fallback determinístico si LLM vacío', async () => {
    const { llm } = makeLlm('');
    const node = makeCancelBuildConfirmMessageNode({ llm, logger: mockLogger });
    const out = await node({ subgraphState: readyDraft() });
    expect(out.confirmation?.message).toMatch(/cancelar/i);
  });
});

// ============================================================================
// gateConfirm
// ============================================================================

const GATE_UUID = '11111111-2222-3333-4444-555555555555';

function gateReadyDraft(): CancelDraftState {
  const d = readyDraft();
  d.confirmation = {
    intentUuid: GATE_UUID,
    message: '¿Cancelo Turno 1?',
    requestedAt: '2026-05-27T12:00:00Z',
  };
  return d;
}

function buildGateHarness() {
  const Ann = Annotation.Root({
    subgraphState: Annotation<CancelDraftState>({
      reducer: (current, next) => ({
        ...current,
        ...next,
        slots: { ...current.slots, ...(next.slots ?? {}) },
        confirmation: next.confirmation !== undefined ? next.confirmation : current.confirmation,
        meta: {
          attempts: current.meta.attempts + (next.meta?.attempts ?? 0),
          recoverableErrors: [
            ...current.meta.recoverableErrors,
            ...(next.meta?.recoverableErrors ?? []),
          ],
        },
      }),
      default: () => initialCancelDraftState(),
    }),
  });
  const node = makeCancelGateConfirmNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('gate', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'gate')
    .addEdge('gate', END)
    .compile({ checkpointer: new MemorySaver() });
}

describe('cancel.gateConfirm', () => {
  it('interrupt con buttons confirm:<uuid> / cancel:<uuid> titled "Sí, cancelar"/"No"', async () => {
    const graph = buildGateHarness();
    const result = await graph.invoke(
      { subgraphState: gateReadyDraft() },
      { configurable: { thread_id: 't-gate' } },
    );
    const payload = result.__interrupt__[0].value as {
      pendingReply: { buttons: Array<{ id: string; title: string }> };
    };
    expect(payload.pendingReply.buttons).toEqual([
      { id: `confirm:${GATE_UUID}`, title: 'Sí, cancelar' },
      { id: `cancel:${GATE_UUID}`, title: 'No' },
    ]);
  });

  it('confirm match → phase=committing', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 't-conf' } };
    await graph.invoke({ subgraphState: gateReadyDraft() }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${GATE_UUID}` } }),
      config,
    );
    expect(resumed.subgraphState.phase).toBe('committing');
  });

  it('cancel match → limpia confirmation, vuelve a collecting (slots preservados)', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 't-canc' } };
    await graph.invoke({ subgraphState: gateReadyDraft() }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `cancel:${GATE_UUID}` } }),
      config,
    );
    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
    expect(resumed.subgraphState.slots.appointmentUuid.value).toBe('apt-1'); // preservado
  });

  it('stale uuid → tratado como cancel implícito', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 't-stale' } };
    await graph.invoke({ subgraphState: gateReadyDraft() }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'confirm:OTHER-UUID' } }),
      config,
    );
    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
  });

  it('texto libre → cancel implícito', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 't-text' } };
    await graph.invoke({ subgraphState: gateReadyDraft() }, config);
    const resumed = await graph.invoke(new Command({ resume: { text: 'no, déjalo así' } }), config);
    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
  });
});

// ============================================================================
// commit
// ============================================================================

function makeGuacuco(
  fn: (p: unknown, o?: unknown) => Promise<CancelAppointmentResult>,
): GuacucoClient {
  return { cancelAppointment: fn } as unknown as GuacucoClient;
}

function successCancelResult(): CancelAppointmentResult {
  return { response_type: 'text', message: 'ok', appointment_uuid: 'apt-1', status: 0 };
}

function committingDraft(): CancelDraftState {
  const d = gateReadyDraft();
  d.phase = 'committing';
  return d;
}

describe('cancel.commit', () => {
  it('happy: phase=done, idempotencyKey=intentUuid', async () => {
    const fn = vi.fn(async () => successCancelResult());
    const node = makeCancelCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ subgraphState: committingDraft() });
    expect(out.phase).toBe('done');
    expect(fn).toHaveBeenCalledWith({ appointment_uuid: 'apt-1' }, { idempotencyKey: GATE_UUID });
  });

  it('anti-alucinación: slot no resolved lanza IdpError', async () => {
    const draft = committingDraft();
    draft.slots.appointmentUuid = { status: 'empty' };
    const fn = vi.fn();
    const node = makeCancelCommitNode({ guacuco: makeGuacuco(fn as never), logger: mockLogger });
    await expect(node({ subgraphState: draft })).rejects.toBeInstanceOf(IdpError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('APPOINTMENT_ALREADY_CANCELLED → silent success', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('APPOINTMENT_ALREADY_CANCELLED', 'already');
    });
    const node = makeCancelCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ subgraphState: committingDraft() });
    expect(out.phase).toBe('done');
  });

  it('APPOINTMENT_NOT_FOUND → terminal error', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('APPOINTMENT_NOT_FOUND', 'gone');
    });
    const node = makeCancelCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ subgraphState: committingDraft() });
    expect(out.terminalOutcome?.action).toBe('error');
  });

  it('falta intentUuid → error terminal', async () => {
    const draft = committingDraft();
    draft.confirmation = {};
    const fn = vi.fn();
    const node = makeCancelCommitNode({ guacuco: makeGuacuco(fn as never), logger: mockLogger });
    const out = await node({ subgraphState: draft });
    expect(out.phase).toBe('failed');
    expect(out.terminalOutcome?.action).toBe('error');
    expect(fn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// successResponse
// ============================================================================

describe('cancel.successResponse', () => {
  it('genera texto con displayName + ofrece reprogramar', async () => {
    const { llm } = makeLlm('Cancelé Turno 1. Si querés reprogramar, decímelo.');
    const node = makeCancelSuccessNode({ llm, logger: mockLogger });
    const draft = { ...readyDraft(), phase: 'done' as const };
    const out = await node({ subgraphState: draft });
    expect(out.terminalOutcome?.action).toBe('response');
    expect(out.terminalOutcome?.pendingReply?.text).toMatch(/cancel|reprogram/i);
  });

  it('fallback determinístico si LLM vacío', async () => {
    const { llm } = makeLlm('');
    const node = makeCancelSuccessNode({ llm, logger: mockLogger });
    const draft = { ...readyDraft(), phase: 'done' as const };
    const out = await node({ subgraphState: draft });
    expect(out.terminalOutcome?.pendingReply?.text).toMatch(/cancel/i);
  });
});
