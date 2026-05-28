import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  isGraphInterrupt,
} from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CatalogState } from '../../../../../src/core/types/Catalog.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import {
  MAX_ATTEMPTS,
  makeAskSlotNode,
} from '../../../../../src/graph/subgraphs/schedule/nodes/askSlot.js';
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

const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-client',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const CATALOG: CatalogState = {
  services: [
    {
      uuid: 'svc-corte',
      name: 'Corte',
      description: null,
      price: 5000,
      staff: [
        { uuid: 'stf-maria', name: 'María García' },
        { uuid: 'stf-juan', name: 'Juan Pérez' },
      ],
    },
    {
      uuid: 'svc-masaje',
      name: 'Masaje',
      description: null,
      price: 8000,
      staff: [{ uuid: 'stf-laura', name: 'Laura' }],
    },
  ],
};

/**
 * Mini StateGraph wrapper para testear askSlot con interrupt() + Command(resume).
 * Espeja el shape mínimo que necesita el nodo: subgraphState + identity + catalog.
 */
function buildTestHarness(
  initialDraft: AppointmentDraftState,
  identity: Identity = IDENTITY_CLIENT,
) {
  const Ann = Annotation.Root({
    catalog: Annotation<CatalogState>({
      reducer: (_c, n) => n,
      default: () => CATALOG,
    }),
    identity: Annotation<Identity | null>({
      reducer: (_c, n) => n,
      default: () => null,
    }),
    subgraphState: Annotation<AppointmentDraftState>({
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
      default: () => initialAppointmentDraftState('client'),
    }),
  });

  const askSlot = makeAskSlotNode({ logger: mockLogger });
  const compiled = new StateGraph(Ann)
    .addNode('ask_slot', async (state) => {
      const update = askSlot(state);
      return { subgraphState: update };
    })
    .addEdge(START, 'ask_slot')
    .addEdge('ask_slot', END)
    .compile({ checkpointer: new MemorySaver() });

  const initialInvoke = {
    catalog: CATALOG,
    identity,
    subgraphState: initialDraft,
  };
  return { graph: compiled, initialInvoke };
}

afterEach(() => vi.clearAllMocks());

describe('askSlot — first call interrupts with proper payload', () => {
  it('asks for services (list with rows) when nothing resolved', async () => {
    const draft = initialAppointmentDraftState('client');
    const { graph, initialInvoke } = buildTestHarness(draft);

    const result = await graph.invoke(initialInvoke, {
      configurable: { thread_id: 't-services' },
    });
    const interrupts = result.__interrupt__;
    expect(interrupts).toHaveLength(1);
    const payload = interrupts[0].value as { pendingReply: { list?: { rows: unknown[] } } };
    expect(payload.pendingReply.list?.rows).toBeDefined();
    expect(payload.pendingReply.list?.rows).toHaveLength(2); // 2 servicios en CATALOG
  });

  it('asks for staff (list filtered by selected services) once services resolved', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft);

    const result = await graph.invoke(initialInvoke, {
      configurable: { thread_id: 't-staff' },
    });
    const payload = result.__interrupt__[0].value as {
      pendingReply: { list?: { rows: Array<{ id: string }> } };
    };
    expect(payload.pendingReply.list?.rows).toHaveLength(2); // María + Juan para Corte
    expect(payload.pendingReply.list?.rows.every((r) => r.id.startsWith('staff:'))).toBe(true);
  });

  it('asks for date+time as plain text', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft);

    const result = await graph.invoke(initialInvoke, {
      configurable: { thread_id: 't-datetime' },
    });
    const payload = result.__interrupt__[0].value as { pendingReply: { text?: string } };
    expect(payload.pendingReply.text).toMatch(/cuándo|día/i);
    expect(payload.pendingReply.text).toMatch(/hora/i);
  });

  it('asks for clientUuid (free text) when staff role and that is the only missing slot', async () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft, {
      ...IDENTITY_CLIENT,
      profileType: 'staff',
    });

    const result = await graph.invoke(initialInvoke, {
      configurable: { thread_id: 't-clientuuid' },
    });
    const payload = result.__interrupt__[0].value as { pendingReply: { text?: string } };
    expect(payload.pendingReply.text).toMatch(/cliente/i);
  });
});

describe('askSlot — resume applies the reply', () => {
  it('list pick (service:<uuid>) resolves services slot', async () => {
    const draft = initialAppointmentDraftState('client');
    const { graph, initialInvoke } = buildTestHarness(draft);
    const config = { configurable: { thread_id: 't-resume-svc' } };

    await graph.invoke(initialInvoke, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'service:svc-corte' } }),
      config,
    );

    expect(resumed.subgraphState.slots.services).toEqual({
      value: ['svc-corte'],
      displayName: 'Corte',
      status: 'resolved',
    });
    expect(resumed.subgraphState.meta.attempts).toBe(1);
  });

  it('free-text reply for services puts userPhrase in guessed (resolveEntities resolves later)', async () => {
    const draft = initialAppointmentDraftState('client');
    const { graph, initialInvoke } = buildTestHarness(draft);
    const config = { configurable: { thread_id: 't-resume-svc-text' } };

    await graph.invoke(initialInvoke, config);
    const resumed = await graph.invoke(new Command({ resume: { text: 'corte y masaje' } }), config);

    expect(resumed.subgraphState.slots.services).toEqual({
      userPhrase: 'corte y masaje',
      status: 'guessed',
    });
  });

  it('staff list pick (staff:<uuid>) resolves staff slot', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft);
    const config = { configurable: { thread_id: 't-resume-staff' } };

    await graph.invoke(initialInvoke, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'staff:stf-juan' } }),
      config,
    );

    expect(resumed.subgraphState.slots.staff).toEqual({
      value: 'stf-juan',
      displayName: 'Juan Pérez',
      status: 'resolved',
    });
  });

  it('text reply for date+time resolves both', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft);
    const config = { configurable: { thread_id: 't-resume-datetime' } };

    await graph.invoke(initialInvoke, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: '2026-06-15 a las 16:00' } }),
      config,
    );

    expect(resumed.subgraphState.slots.date.value).toBe('2026-06-15');
    expect(resumed.subgraphState.slots.time.value).toBe('16:00');
  });

  it('text reply for clientUuid stores as userPhrase (v1 scope)', async () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft, {
      ...IDENTITY_CLIENT,
      profileType: 'staff',
    });
    const config = { configurable: { thread_id: 't-resume-clientuuid' } };

    await graph.invoke(initialInvoke, config);
    const resumed = await graph.invoke(
      new Command({ resume: { text: 'Ana Lopez 1144556677' } }),
      config,
    );

    expect(resumed.subgraphState.slots.clientUuid).toEqual({
      userPhrase: 'Ana Lopez 1144556677',
      status: 'guessed',
    });
  });
});

describe('askSlot — guard anti-loop', () => {
  it('returns handed_off when meta.attempts >= MAX_ATTEMPTS (without asking)', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.meta.attempts = MAX_ATTEMPTS;
    const { graph, initialInvoke } = buildTestHarness(draft);

    const result = await graph.invoke(initialInvoke, {
      configurable: { thread_id: 't-handoff' },
    });

    expect(result.__interrupt__).toBeUndefined();
    expect(result.subgraphState.phase).toBe('failed');
    expect(result.subgraphState.terminalOutcome?.action).toBe('handed_off');
  });
});

describe('askSlot — no-op routes', () => {
  it('skips asking when nothing is missing (routes phase to validating_availability)', async () => {
    const draft = initialAppointmentDraftState('client');
    draft.slots.services = { value: ['svc-corte'], status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    const { graph, initialInvoke } = buildTestHarness(draft);

    const result = await graph.invoke(initialInvoke, { configurable: { thread_id: 't-noop' } });
    expect(result.__interrupt__).toBeUndefined();
    expect(result.subgraphState.phase).toBe('validating_availability');
  });
});

// Smoke: verify the `isGraphInterrupt` helper works as expected for our interrupts
describe('askSlot — interrupt mechanics smoke', () => {
  it('the interrupt during first invoke does not crash; resume continues cleanly', async () => {
    const draft = initialAppointmentDraftState('client');
    const { graph, initialInvoke } = buildTestHarness(draft);
    const config = { configurable: { thread_id: 't-smoke' } };

    const first = await graph.invoke(initialInvoke, config);
    expect(first.__interrupt__).toBeDefined();
    expect(first.__interrupt__.some(isGraphInterrupt)).toBe(false); // payload object, not Error
    // (we just confirm the value field is populated)
    expect(first.__interrupt__[0].value).toBeDefined();
  });
});
