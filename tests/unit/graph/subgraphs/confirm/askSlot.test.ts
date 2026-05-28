import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CrmContext } from '../../../../../src/core/types/CrmContext.js';
import {
  CONFIRM_MAX_ATTEMPTS,
  makeConfirmAskSlotNode,
} from '../../../../../src/graph/subgraphs/confirm/nodes/askSlot.js';
import {
  type ConfirmDraftState,
  initialConfirmDraftState,
} from '../../../../../src/graph/subgraphs/confirm/state.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CRM_TWO: CrmContext = {
  upcomingAppointments: [
    { appointmentUuid: 'apt-1', description: 'Corte con María', startAt: '2026-05-28T16:00' },
    { appointmentUuid: 'apt-2', description: 'Color con Pedro', startAt: '2026-06-04T10:00' },
  ],
  profileMeta: {},
};

function buildHarness() {
  const Ann = Annotation.Root({
    crmContext: Annotation<CrmContext>({
      reducer: (_c, n) => n,
      default: () => ({ upcomingAppointments: [], profileMeta: {} }),
    }),
    subgraphState: Annotation<ConfirmDraftState>({
      reducer: (current, next) => ({
        ...current,
        ...next,
        slots: { ...current.slots, ...(next.slots ?? {}) },
        meta: {
          attempts: current.meta.attempts + (next.meta?.attempts ?? 0),
          recoverableErrors: [
            ...current.meta.recoverableErrors,
            ...(next.meta?.recoverableErrors ?? []),
          ],
        },
      }),
      default: () => initialConfirmDraftState(),
    }),
  });

  const node = makeConfirmAskSlotNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('ask', async (state) => ({ subgraphState: node(state) }))
    .addEdge(START, 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new MemorySaver() });
}

afterEach(() => vi.clearAllMocks());

describe('confirm.askSlot — first call', () => {
  it('interrupts with list of upcomings (apt_pick:<uuid>)', async () => {
    const graph = buildHarness();
    const result = await graph.invoke(
      { crmContext: CRM_TWO, subgraphState: initialConfirmDraftState() },
      { configurable: { thread_id: 't-ask' } },
    );
    const payload = result.__interrupt__[0].value as {
      pendingReply: { list?: { rows: Array<{ id: string; title: string }> } };
    };
    expect(payload.pendingReply.list?.rows).toEqual([
      { id: 'apt_pick:apt-1', title: 'Corte con María', description: '2026-05-28T16:00' },
      { id: 'apt_pick:apt-2', title: 'Color con Pedro', description: '2026-06-04T10:00' },
    ]);
  });

  it('falls back to text when no upcomings in CRM (edge case)', async () => {
    const graph = buildHarness();
    const result = await graph.invoke(
      {
        crmContext: { upcomingAppointments: [], profileMeta: {} },
        subgraphState: initialConfirmDraftState(),
      },
      { configurable: { thread_id: 't-ask-empty' } },
    );
    const payload = result.__interrupt__[0].value as { pendingReply: { text?: string } };
    expect(payload.pendingReply.text).toMatch(/turno/i);
  });
});

describe('confirm.askSlot — resume', () => {
  it('apt_pick:<uuid> matching → resolves slot, phase=committing', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-pick' } };
    await graph.invoke({ crmContext: CRM_TWO, subgraphState: initialConfirmDraftState() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:apt-2' } }),
      config,
    );
    expect(resumed.subgraphState.slots.appointmentUuid).toEqual({
      value: 'apt-2',
      displayName: 'Color con Pedro',
      status: 'resolved',
    });
    expect(resumed.subgraphState.phase).toBe('committing');
    expect(resumed.subgraphState.meta.attempts).toBe(1);
  });

  it('apt_pick:<unknown-uuid> → no resolve, attempts++', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-bad' } };
    await graph.invoke({ crmContext: CRM_TWO, subgraphState: initialConfirmDraftState() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'apt_pick:NOT-IN-LIST' } }),
      config,
    );
    expect(resumed.subgraphState.slots.appointmentUuid.status).toBe('empty');
    expect(resumed.subgraphState.meta.attempts).toBe(1);
  });

  it('free text → status=guessed (no resolve UUID en v1)', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-text' } };
    await graph.invoke({ crmContext: CRM_TWO, subgraphState: initialConfirmDraftState() }, config);

    const resumed = await graph.invoke(new Command({ resume: { text: 'el de María' } }), config);
    expect(resumed.subgraphState.slots.appointmentUuid.status).toBe('guessed');
    expect(resumed.subgraphState.slots.appointmentUuid.userPhrase).toBe('el de María');
  });
});

describe('confirm.askSlot — guard anti-loop', () => {
  it('attempts >= MAX → handed_off without interrupt', async () => {
    const draft = initialConfirmDraftState();
    draft.meta.attempts = CONFIRM_MAX_ATTEMPTS;
    const graph = buildHarness();
    const result = await graph.invoke(
      { crmContext: CRM_TWO, subgraphState: draft },
      { configurable: { thread_id: 't-handoff' } },
    );
    expect(result.__interrupt__).toBeUndefined();
    expect(result.subgraphState.phase).toBe('failed');
    expect(result.subgraphState.terminalOutcome?.action).toBe('handed_off');
  });
});
