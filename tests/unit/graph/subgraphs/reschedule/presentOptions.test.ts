import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeReschedulePresentOptionsNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/presentOptions.js';
import {
  type RescheduleDraftState,
  initialRescheduleDraftState,
} from '../../../../../src/graph/subgraphs/reschedule/state.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function draftWithProposed(
  proposed: Array<{ date: string; time: string; label: string }>,
): RescheduleDraftState {
  const d = initialRescheduleDraftState();
  d.slots.appointmentUuid = { value: 'apt-1', status: 'resolved' };
  d.slots.newDate = { value: '2026-06-05', status: 'resolved' };
  d.slots.newTime = { value: '14:00', status: 'resolved' };
  d.availability = {
    lastCheckedFor: {
      appointmentUuid: 'apt-1',
      newDate: '2026-06-05',
      newTime: '14:00',
    },
    exactMatch: false,
    proposedSlots: proposed,
  };
  d.phase = 'awaiting_pick';
  return d;
}

function buildHarness() {
  const Ann = Annotation.Root({
    identity: Annotation<Identity>({
      reducer: (_c, n) => n,
      default: () => IDENTITY,
    }),
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
  const node = makeReschedulePresentOptionsNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('present', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'present')
    .addEdge('present', END)
    .compile({ checkpointer: new MemorySaver() });
}

afterEach(() => vi.clearAllMocks());

describe('reschedule.presentOptions', () => {
  it('proposed_slots vacíos → handed_off', () => {
    const node = makeReschedulePresentOptionsNode({ logger: mockLogger });
    const update = node({ identity: IDENTITY, subgraphState: draftWithProposed([]) });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });

  it('emits list with slot_pick ids', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 'p-1' } };
    const result = await graph.invoke(
      {
        subgraphState: draftWithProposed([
          { date: '2026-06-05', time: '15:00', label: '5 jun 15:00' },
          { date: '2026-06-05', time: '16:00', label: '5 jun 16:00' },
        ]),
      },
      config,
    );
    const interrupt = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__?.[0]
      ?.value as { pendingReply?: { list?: { rows: Array<{ id: string; title: string }> } } };
    expect(interrupt?.pendingReply?.list?.rows).toEqual([
      { id: 'slot_pick:0', title: '5 jun 15:00' },
      { id: 'slot_pick:1', title: '5 jun 16:00' },
    ]);
  });

  it('pick → copies date/time, exactMatch=true, phase awaiting_confirmation', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 'p-2' } };
    await graph.invoke(
      {
        subgraphState: draftWithProposed([
          { date: '2026-06-05', time: '15:00', label: '5 jun 15:00' },
          { date: '2026-06-05', time: '16:00', label: '5 jun 16:00' },
        ]),
      },
      config,
    );
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'slot_pick:1' } }),
      config,
    );
    expect(resumed.subgraphState.slots.newDate.value).toBe('2026-06-05');
    expect(resumed.subgraphState.slots.newTime.value).toBe('16:00');
    expect(resumed.subgraphState.availability.exactMatch).toBe(true);
    expect(resumed.subgraphState.availability.proposedSlots).toEqual([]);
    expect(resumed.subgraphState.phase).toBe('awaiting_confirmation');
  });

  it('free text → re-parse, clear availability cache, phase collecting', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 'p-3' } };
    await graph.invoke(
      {
        subgraphState: draftWithProposed([
          { date: '2026-06-05', time: '15:00', label: '5 jun 15:00' },
        ]),
      },
      config,
    );
    const resumed = await graph.invoke(
      new Command({ resume: { text: 'mejor el 2026-06-10 a las 09:00' } }),
      config,
    );
    expect(resumed.subgraphState.slots.newDate.value).toBe('2026-06-10');
    expect(resumed.subgraphState.slots.newTime.value).toBe('09:00');
    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.availability.proposedSlots).toEqual([]);
  });
});
