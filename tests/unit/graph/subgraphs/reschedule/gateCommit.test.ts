import type Anthropic from '@anthropic-ai/sdk';
import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { RescheduleAppointmentResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import { IdpError } from '../../../../../src/core/errors/IdpError.js';
import { ToolExecutionError } from '../../../../../src/core/errors/ToolExecutionError.js';
import { makeRescheduleBuildConfirmMessageNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/buildConfirmMessage.js';
import { makeRescheduleCommitNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/commit.js';
import { makeRescheduleGateConfirmNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/gateConfirm.js';
import { makeRescheduleSuccessNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/successResponse.js';
import {
  type RescheduleDraftState,
  initialRescheduleDraftState,
} from '../../../../../src/graph/subgraphs/reschedule/state.js';
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

function readyDraft(): RescheduleDraftState {
  const d = initialRescheduleDraftState();
  d.slots.appointmentUuid = {
    value: 'apt-1',
    displayName: 'Corte con María',
    status: 'resolved',
  };
  d.slots.newDate = { value: '2026-06-05', status: 'resolved' };
  d.slots.newTime = { value: '14:00', status: 'resolved' };
  return d;
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// buildConfirmMessage
// ============================================================================

describe('reschedule.buildConfirmMessage', () => {
  it('calls LLM and caches intentUuid + message', async () => {
    const { llm, create } = makeLlm('Reagendo Corte con María al 5/6 a las 14:00. ¿Confirmás?');
    const node = makeRescheduleBuildConfirmMessageNode({ llm, logger: mockLogger });
    const update = await node({ subgraphState: readyDraft() });
    expect(create).toHaveBeenCalledOnce();
    expect(update.confirmation?.intentUuid).toBeDefined();
    expect(update.confirmation?.message).toMatch(/reagendo|reagendamiento|confirmás/i);
    expect(update.phase).toBe('awaiting_confirmation');
  });

  it('idempotent: skips LLM when intentUuid + message already cached', async () => {
    const { llm, create } = makeLlm('should not be called');
    const node = makeRescheduleBuildConfirmMessageNode({ llm, logger: mockLogger });
    const cached = readyDraft();
    cached.confirmation = { intentUuid: 'existing-uuid', message: 'existing' };
    await node({ subgraphState: cached });
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to template when LLM returns empty', async () => {
    const { llm } = makeLlm('');
    const node = makeRescheduleBuildConfirmMessageNode({ llm, logger: mockLogger });
    const update = await node({ subgraphState: readyDraft() });
    expect(update.confirmation?.message).toMatch(/reagendar/i);
    expect(update.confirmation?.message).toMatch(/Corte con María/);
  });

  it('does not call LLM when slots unresolved', async () => {
    const { llm, create } = makeLlm('x');
    const node = makeRescheduleBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ subgraphState: initialRescheduleDraftState() });
    expect(create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// gateConfirm — uses harness for interrupt
// ============================================================================

function buildGateHarness() {
  const Ann = Annotation.Root({
    subgraphState: Annotation<RescheduleDraftState>({
      reducer: (current, next) => ({
        ...current,
        ...next,
        slots: { ...current.slots, ...(next.slots ?? {}) },
        availability: next.availability !== undefined ? next.availability : current.availability,
        confirmation: next.confirmation !== undefined ? next.confirmation : current.confirmation,
        meta: {
          attempts: current.meta.attempts + (next.meta?.attempts ?? 0),
          recoverableErrors: [
            ...current.meta.recoverableErrors,
            ...(next.meta?.recoverableErrors ?? []),
          ],
        },
      }),
      default: () => initialRescheduleDraftState(),
    }),
  });
  const node = makeRescheduleGateConfirmNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('gate', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'gate')
    .addEdge('gate', END)
    .compile({ checkpointer: new MemorySaver() });
}

describe('reschedule.gateConfirm', () => {
  it('emits buttons Sí, reagendar / No', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 'g-1' } };
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1', message: 'pregunta' };
    draft.phase = 'awaiting_confirmation';
    const result = await graph.invoke({ subgraphState: draft }, config);
    const interrupt = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__?.[0]
      ?.value as { pendingReply?: { buttons?: Array<{ id: string; title: string }> } };
    expect(interrupt?.pendingReply?.buttons).toEqual([
      { id: 'confirm:iu-1', title: 'Sí, reagendar' },
      { id: 'cancel:iu-1', title: 'No' },
    ]);
  });

  it('confirm button → phase committing', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 'g-2' } };
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-2', message: 'q' };
    draft.phase = 'awaiting_confirmation';
    await graph.invoke({ subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'confirm:iu-2' } }),
      config,
    );
    expect(resumed.subgraphState.phase).toBe('committing');
  });

  it('cancel button → cancels gate (clears confirmation, back to collecting)', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 'g-3' } };
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-3', message: 'q' };
    draft.phase = 'awaiting_confirmation';
    await graph.invoke({ subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'cancel:iu-3' } }),
      config,
    );
    expect(resumed.subgraphState.confirmation).toEqual({});
    expect(resumed.subgraphState.phase).toBe('collecting');
    // slots preservados
    expect(resumed.subgraphState.slots.appointmentUuid.value).toBe('apt-1');
  });

  it('stale uuid (different intentUuid) → cancels gate', async () => {
    const graph = buildGateHarness();
    const config = { configurable: { thread_id: 'g-4' } };
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'fresh', message: 'q' };
    draft.phase = 'awaiting_confirmation';
    await graph.invoke({ subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'confirm:stale' } }),
      config,
    );
    expect(resumed.subgraphState.confirmation).toEqual({});
    expect(resumed.subgraphState.phase).toBe('collecting');
  });
});

// ============================================================================
// commit
// ============================================================================

function defaultSuccess(): RescheduleAppointmentResult {
  return {
    response_type: 'text',
    message: 'ok',
    appointment_uuid: 'apt-1',
    business_uuid: 'biz-1',
    client_uuid: 'cli-1',
    appointment_date: '2026-06-05',
    start_time: '14:00',
    end_time: '15:00',
    status: 1,
    staff_assignments: [],
  };
}

function makeGuacuco(impl: () => Promise<RescheduleAppointmentResult>): {
  guacuco: GuacucoClient;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(impl);
  return {
    guacuco: { rescheduleAppointment: call } as unknown as GuacucoClient,
    call,
  };
}

describe('reschedule.commit', () => {
  it('happy: calls rescheduleAppointment with intentUuid + new params', async () => {
    const { guacuco, call } = makeGuacuco(async () => defaultSuccess());
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    draft.phase = 'committing';
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('done');
    expect(call).toHaveBeenCalledWith(
      { appointment_uuid: 'apt-1', new_date: '2026-06-05', new_time: '14:00' },
      { idempotencyKey: 'iu-1' },
    );
  });

  it('asserts slots resolved (anti-alucinación) → throws IdpError on missing', async () => {
    const { guacuco } = makeGuacuco(async () => defaultSuccess());
    const draft = initialRescheduleDraftState(); // todos empty
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    await expect(node({ subgraphState: draft })).rejects.toBeInstanceOf(IdpError);
  });

  it('STAFF_NOT_AVAILABLE 1st time → recovery (back to validating + clean confirmation)', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new ToolExecutionError('STAFF_NOT_AVAILABLE', 'race');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('validating_availability');
    expect(update.confirmation).toEqual({});
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.meta?.recoverableErrors).toContain('STAFF_NOT_AVAILABLE');
  });

  it('STAFF_NOT_AVAILABLE 2nd time → handed_off', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new ToolExecutionError('STAFF_NOT_AVAILABLE', 'race again');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    draft.meta.recoverableErrors = ['STAFF_NOT_AVAILABLE'];
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });

  it('APPOINTMENT_NOT_FOUND → error terminal con texto explicativo', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new ToolExecutionError('APPOINTMENT_NOT_FOUND', '');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no encontré/i);
  });

  it('APPOINTMENT_ALREADY_CANCELLED → error con texto "ya no se puede reagendar"', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new ToolExecutionError('APPOINTMENT_ALREADY_CANCELLED', '');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no se puede reagendar/i);
  });

  it('IDEMPOTENT_REQUEST_IN_PROGRESS → handed_off in_progress', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new ToolExecutionError('IDEMPOTENT_REQUEST_IN_PROGRESS', '');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/procesado/i);
  });

  it('net error → error terminal', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new Error('ECONNRESET');
    });
    const draft = readyDraft();
    draft.confirmation = { intentUuid: 'iu-1' };
    const node = makeRescheduleCommitNode({ guacuco, logger: mockLogger });
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });
});

// ============================================================================
// successResponse
// ============================================================================

describe('reschedule.successResponse', () => {
  it('produces response Outcome with LLM text', async () => {
    const { llm } = makeLlm('¡Reagendado al 5 de junio a las 14:00!');
    const node = makeRescheduleSuccessNode({ llm, logger: mockLogger });
    const draft = readyDraft();
    draft.phase = 'done';
    const update = await node({ subgraphState: draft });
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/reagendado/i);
  });

  it('falls back when LLM returns empty', async () => {
    const { llm } = makeLlm('');
    const node = makeRescheduleSuccessNode({ llm, logger: mockLogger });
    const draft = readyDraft();
    const update = await node({ subgraphState: draft });
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/reagendé/i);
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/Corte con María/);
  });
});
