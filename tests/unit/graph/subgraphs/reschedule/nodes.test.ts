import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import {
  RESCHEDULE_MAX_ATTEMPTS,
  makeRescheduleAskSlotNode,
} from '../../../../../src/graph/subgraphs/reschedule/nodes/askSlot.js';
import { makeRescheduleBootstrapNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/bootstrap.js';
import {
  type RescheduleDraftState,
  initialRescheduleDraftState,
} from '../../../../../src/graph/subgraphs/reschedule/state.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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

function upcoming(uuid: string, description = 'Corte con María'): UpcomingAppointment {
  return {
    appointmentUuid: uuid,
    description,
    startAt: '2026-05-30T10:00',
  };
}

function crm(upcomings: UpcomingAppointment[]): CrmContext {
  return { upcomingAppointments: upcomings, profileMeta: {} };
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// bootstrap (función pura, sin grafo)
// ============================================================================

describe('reschedule.bootstrap', () => {
  it('0 upcomings → failed + response amable', () => {
    const node = makeRescheduleBootstrapNode({ logger: mockLogger });
    const update = node({ crmContext: crm([]) });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no tenés turnos/i);
  });

  it('1 upcoming → pre-fill appointmentUuid + phase collecting', () => {
    const node = makeRescheduleBootstrapNode({ logger: mockLogger });
    const update = node({ crmContext: crm([upcoming('apt-1', 'Corte')]) });
    expect(update.phase).toBe('collecting');
    expect(update.slots?.appointmentUuid.status).toBe('resolved');
    expect(update.slots?.appointmentUuid.value).toBe('apt-1');
    expect(update.slots?.appointmentUuid.displayName).toBe('Corte');
    expect(update.slots?.newDate.status).toBe('empty');
    expect(update.slots?.newTime.status).toBe('empty');
  });

  it('2+ upcomings → collecting sin pre-fill', () => {
    const node = makeRescheduleBootstrapNode({ logger: mockLogger });
    const update = node({
      crmContext: crm([upcoming('apt-1'), upcoming('apt-2', 'Color con Juan')]),
    });
    expect(update.phase).toBe('collecting');
    expect(update.slots).toBeUndefined();
  });
});

// ============================================================================
// askSlot — harness con Annotation.Root + node wrapper
// ============================================================================

function buildAskHarness() {
  const Ann = Annotation.Root({
    identity: Annotation<Identity>({
      reducer: (_c, n) => n,
      default: () => IDENTITY,
    }),
    crmContext: Annotation<CrmContext>({
      reducer: (_c, n) => n,
      default: () => ({ upcomingAppointments: [], profileMeta: {} }),
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
  const node = makeRescheduleAskSlotNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('ask', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new MemorySaver() });
}

describe('reschedule.askSlot — appointmentUuid missing', () => {
  it('emits list with apt_pick buttons when upcomings present', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 'ask-1' } };
    const result = await graph.invoke(
      {
        crmContext: crm([upcoming('apt-1', 'Corte'), upcoming('apt-2', 'Color')]),
        subgraphState: initialRescheduleDraftState(),
      },
      config,
    );
    const interrupt = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__?.[0]
      ?.value as { pendingReply?: { list?: { rows: Array<{ id: string }> } } };
    expect(interrupt?.pendingReply?.list?.rows).toHaveLength(2);
    expect(interrupt?.pendingReply?.list?.rows[0]?.id).toBe('apt_pick:apt-1');
  });

  it('resolves appointmentUuid from apt_pick button', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 'ask-2' } };
    await graph.invoke(
      {
        crmContext: crm([upcoming('apt-1', 'Corte'), upcoming('apt-2', 'Color')]),
        subgraphState: initialRescheduleDraftState(),
      },
      config,
    );
    const second = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:apt-2' } }),
      config,
    );
    expect(second.subgraphState.slots.appointmentUuid.value).toBe('apt-2');
    expect(second.subgraphState.slots.appointmentUuid.status).toBe('resolved');
    expect(second.subgraphState.meta.attempts).toBe(1);
  });
});

describe('reschedule.askSlot — newDateTime missing', () => {
  function draftWithApt(): RescheduleDraftState {
    const d = initialRescheduleDraftState();
    d.slots.appointmentUuid = { value: 'apt-1', status: 'resolved' };
    return d;
  }

  it('emits texto pidiendo día y hora', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 'ask-3' } };
    const result = await graph.invoke(
      {
        crmContext: crm([upcoming('apt-1')]),
        subgraphState: draftWithApt(),
      },
      config,
    );
    const interrupt = (result as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__?.[0]
      ?.value as { pendingReply?: { text?: string } };
    expect(interrupt?.pendingReply?.text).toMatch(/cuándo|día/i);
  });

  it('resolves newDate+newTime from text like "mañana a las 16"', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 'ask-4' } };
    await graph.invoke(
      {
        crmContext: crm([upcoming('apt-1')]),
        subgraphState: draftWithApt(),
      },
      config,
    );
    const second = await graph.invoke(new Command({ resume: { text: 'mañana a las 16' } }), config);
    expect(second.subgraphState.slots.newDate.status).toBe('resolved');
    expect(second.subgraphState.slots.newDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(second.subgraphState.slots.newTime.status).toBe('resolved');
    expect(second.subgraphState.slots.newTime.value).toBe('16:00');
  });

  it('marks slots guessed when text cannot be parsed', async () => {
    const graph = buildAskHarness();
    const config = { configurable: { thread_id: 'ask-5' } };
    await graph.invoke(
      {
        crmContext: crm([upcoming('apt-1')]),
        subgraphState: draftWithApt(),
      },
      config,
    );
    const second = await graph.invoke(
      new Command({ resume: { text: 'no entiendo nada' } }),
      config,
    );
    expect(second.subgraphState.slots.newDate.status).toBe('guessed');
    expect(second.subgraphState.slots.newTime.status).toBe('guessed');
  });
});

describe('reschedule.askSlot — guard anti-loop', () => {
  it('hands off after MAX_ATTEMPTS attempts', () => {
    const draft = initialRescheduleDraftState();
    draft.meta.attempts = RESCHEDULE_MAX_ATTEMPTS;
    const node = makeRescheduleAskSlotNode({ logger: mockLogger });
    const update = node({
      identity: IDENTITY,
      crmContext: crm([upcoming('apt-1')]),
      subgraphState: draft,
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });
});
