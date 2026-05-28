import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makePresentOptionsNode } from '../../../../../src/graph/subgraphs/schedule/nodes/presentOptions.js';
import {
  type AppointmentDraftState,
  initialAppointmentDraftState,
} from '../../../../../src/graph/subgraphs/schedule/state.js';

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

function makeDraftWithProposed(
  proposed: AppointmentDraftState['availability']['proposedSlots'],
): AppointmentDraftState {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-corte'], status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  d.availability = {
    lastCheckedFor: {
      date: '2026-05-28',
      time: '16:00',
      staffUuid: 'stf-maria',
      serviceUuids: ['svc-corte'],
    },
    exactMatch: false,
    proposedSlots: proposed,
  };
  d.phase = 'awaiting_pick';
  return d;
}

function buildHarness() {
  const Ann = Annotation.Root({
    identity: Annotation<Identity | null>({
      reducer: (_c, n) => n,
      default: () => null,
    }),
    subgraphState: Annotation<AppointmentDraftState>({
      reducer: (current, next) => ({
        ...current,
        ...next,
        slots: { ...current.slots, ...(next.slots ?? {}) },
        availability: { ...current.availability, ...(next.availability ?? {}) },
      }),
      default: () => initialAppointmentDraftState('client'),
    }),
  });

  const presentOptions = makePresentOptionsNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('present_options', async (state) => {
      const update = presentOptions(state);
      return { subgraphState: update };
    })
    .addEdge(START, 'present_options')
    .addEdge('present_options', END)
    .compile({ checkpointer: new MemorySaver() });
}

afterEach(() => vi.clearAllMocks());

describe('presentOptions — first call', () => {
  it('interrupts with a list of proposedSlots', async () => {
    const proposed = [
      { date: '2026-05-28', time: '17:00', label: '28 mayo - 17:00' },
      { date: '2026-05-29', time: '10:00', label: '29 mayo - 10:00' },
    ];
    const graph = buildHarness();

    const result = await graph.invoke(
      { identity: IDENTITY, subgraphState: makeDraftWithProposed(proposed) },
      { configurable: { thread_id: 't-present' } },
    );
    const payload = result.__interrupt__[0].value as {
      pendingReply: { list?: { rows: Array<{ id: string; title: string }> } };
    };
    expect(payload.pendingReply.list?.rows).toEqual([
      { id: 'slot_pick:0', title: '28 mayo - 17:00' },
      { id: 'slot_pick:1', title: '29 mayo - 10:00' },
    ]);
  });

  it('caps list at 10 rows', async () => {
    const proposed = Array.from({ length: 15 }, (_, i) => ({
      date: '2026-05-28',
      time: `${10 + i}:00`,
      label: `slot ${i}`,
    }));
    const draft = makeDraftWithProposed(proposed);
    const graph = buildHarness();

    const result = await graph.invoke(
      { identity: IDENTITY, subgraphState: draft },
      { configurable: { thread_id: 't-cap' } },
    );
    const rows = (result.__interrupt__[0].value as { pendingReply: { list?: { rows: unknown[] } } })
      .pendingReply.list?.rows;
    expect(rows).toHaveLength(10);
  });

  it('hands off when proposedSlots is empty', async () => {
    const draft = makeDraftWithProposed([]);
    const graph = buildHarness();

    const result = await graph.invoke(
      { identity: IDENTITY, subgraphState: draft },
      { configurable: { thread_id: 't-empty' } },
    );
    expect(result.__interrupt__).toBeUndefined();
    expect(result.subgraphState.phase).toBe('failed');
    expect(result.subgraphState.terminalOutcome?.action).toBe('handed_off');
  });
});

describe('presentOptions — resume with slot_pick', () => {
  it('applies the picked slot, marks exactMatch=true, phase awaiting_confirmation', async () => {
    const proposed = [
      { date: '2026-05-28', time: '17:00', label: '28 mayo - 17:00' },
      { date: '2026-05-29', time: '10:00', label: '29 mayo - 10:00' },
    ];
    const draft = makeDraftWithProposed(proposed);
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-pick' } };

    await graph.invoke({ identity: IDENTITY, subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'slot_pick:1' } }),
      config,
    );

    expect(resumed.subgraphState.slots.date.value).toBe('2026-05-29');
    expect(resumed.subgraphState.slots.time.value).toBe('10:00');
    expect(resumed.subgraphState.availability.exactMatch).toBe(true);
    expect(resumed.subgraphState.availability.proposedSlots).toEqual([]);
    expect(resumed.subgraphState.phase).toBe('awaiting_confirmation');
  });

  it('out-of-range slot_pick:N is ignored (no slot change, stays awaiting_pick)', async () => {
    const proposed = [{ date: '2026-05-28', time: '17:00', label: '28 mayo - 17:00' }];
    const draft = makeDraftWithProposed(proposed);
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-oob' } };

    await graph.invoke({ identity: IDENTITY, subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'slot_pick:9' } }),
      config,
    );
    expect(resumed.subgraphState.slots.date.value).toBe('2026-05-28'); // original
    expect(resumed.subgraphState.slots.time.value).toBe('16:00'); // original
    expect(resumed.subgraphState.phase).toBe('awaiting_pick');
  });
});

describe('presentOptions — resume with free text', () => {
  it('re-parses date/time, clears availability, returns to collecting', async () => {
    const proposed = [{ date: '2026-05-28', time: '17:00', label: '28 mayo - 17:00' }];
    const draft = makeDraftWithProposed(proposed);
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-text' } };

    await graph.invoke({ identity: IDENTITY, subgraphState: draft }, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: 'mejor el 2026-06-15 a las 18:00' } }),
      config,
    );

    expect(resumed.subgraphState.slots.date.value).toBe('2026-06-15');
    expect(resumed.subgraphState.slots.time.value).toBe('18:00');
    expect(resumed.subgraphState.availability.proposedSlots).toEqual([]);
    expect(resumed.subgraphState.phase).toBe('collecting');
  });
});
