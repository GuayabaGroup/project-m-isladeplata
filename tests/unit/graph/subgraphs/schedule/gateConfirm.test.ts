import { Annotation, Command, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeGateConfirmNode } from '../../../../../src/graph/subgraphs/schedule/nodes/gateConfirm.js';
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

const KNOWN_UUID = '11111111-2222-3333-4444-555555555555';

function makeReadyDraft(uuid: string = KNOWN_UUID): AppointmentDraftState {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-corte'], displayName: 'Corte', status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', displayName: 'María', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  d.availability = {
    lastCheckedFor: {
      date: '2026-05-28',
      time: '16:00',
      staffUuid: 'stf-maria',
      serviceUuids: ['svc-corte'],
    },
    exactMatch: true,
    proposedSlots: [],
  };
  d.confirmation = {
    intentUuid: uuid,
    message: 'Voy a agendar tu Corte con María el jueves 28 de mayo a las 16:00. ¿Confirmás?',
    requestedAt: '2026-05-27T12:00:00Z',
  };
  d.phase = 'awaiting_confirmation';
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
        // confirmation y availability se REEMPLAZAN cuando el update los trae
        // (los nodos del subgrafo retornan el shape completo o no lo tocan).
        confirmation: next.confirmation !== undefined ? next.confirmation : current.confirmation,
        availability: next.availability !== undefined ? next.availability : current.availability,
      }),
      default: () => initialAppointmentDraftState('client'),
    }),
  });

  const gateConfirm = makeGateConfirmNode({ logger: mockLogger });
  return new StateGraph(Ann)
    .addNode('gate_confirm', async (state) => {
      const update = gateConfirm(state);
      return { subgraphState: update };
    })
    .addEdge(START, 'gate_confirm')
    .addEdge('gate_confirm', END)
    .compile({ checkpointer: new MemorySaver() });
}

afterEach(() => vi.clearAllMocks());

describe('gateConfirm — first call', () => {
  it('interrupts with confirm/cancel buttons carrying the intentUuid', async () => {
    const graph = buildHarness();
    const result = await graph.invoke(
      { identity: IDENTITY, subgraphState: makeReadyDraft() },
      { configurable: { thread_id: 't-gate' } },
    );

    const payload = result.__interrupt__[0].value as {
      pendingReply: { text: string; buttons: Array<{ id: string; title: string }> };
    };
    expect(payload.pendingReply.text).toMatch(/Corte/);
    expect(payload.pendingReply.buttons).toEqual([
      { id: `confirm:${KNOWN_UUID}`, title: 'Confirmar' },
      { id: `cancel:${KNOWN_UUID}`, title: 'Cancelar' },
    ]);
  });

  it('fails (terminal error) when no intentUuid in confirmation', async () => {
    const draft = makeReadyDraft();
    draft.confirmation = {};
    const graph = buildHarness();
    const result = await graph.invoke(
      { identity: IDENTITY, subgraphState: draft },
      { configurable: { thread_id: 't-noid' } },
    );
    expect(result.__interrupt__).toBeUndefined();
    expect(result.subgraphState.phase).toBe('failed');
    expect(result.subgraphState.terminalOutcome?.action).toBe('error');
  });
});

describe('gateConfirm — confirm button match', () => {
  it('sets phase to committing on matching confirm:<uuid>', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-confirm' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `confirm:${KNOWN_UUID}` } }),
      config,
    );

    expect(resumed.subgraphState.phase).toBe('committing');
    expect(resumed.subgraphState.confirmation.intentUuid).toBe(KNOWN_UUID);
  });
});

describe('gateConfirm — cancel button', () => {
  it('cancel:<uuid> clears confirmation + availability proposedSlots, preserves slots, phase=collecting', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-cancel' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: `cancel:${KNOWN_UUID}` } }),
      config,
    );

    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
    expect(resumed.subgraphState.confirmation.message).toBeUndefined();
    expect(resumed.subgraphState.availability.proposedSlots).toEqual([]);
    // Slots se preservan para que el usuario continúe sin perder lo elegido
    expect(resumed.subgraphState.slots.services.value).toEqual(['svc-corte']);
    expect(resumed.subgraphState.slots.staff.value).toBe('stf-maria');
  });
});

describe('gateConfirm — stale uuid rejection', () => {
  it('stale confirm:<other-uuid> is treated as cancel implícito (does NOT confirm)', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-stale' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: '', buttonId: 'confirm:OTHER-UUID-XX' } }),
      config,
    );

    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.phase).not.toBe('committing');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
  });
});

describe('gateConfirm — cancel implícito con texto libre', () => {
  it('free text without date/time → cancel + collecting, slots preserved', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-text-vague' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(new Command({ resume: { text: 'no, espera' } }), config);

    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
    expect(resumed.subgraphState.slots.time.value).toBe('16:00'); // preservado
  });

  it('free text WITH new time → re-pisa time slot, cancel + collecting', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-text-time' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: 'mejor a las 18hs' } }),
      config,
    );

    expect(resumed.subgraphState.phase).toBe('collecting');
    expect(resumed.subgraphState.slots.time.value).toBe('18:00'); // pisado
    expect(resumed.subgraphState.slots.date.value).toBe('2026-05-28'); // preservado
    expect(resumed.subgraphState.confirmation.intentUuid).toBeUndefined();
  });

  it('free text WITH new date+time → re-pisa ambos', async () => {
    const graph = buildHarness();
    const config = { configurable: { thread_id: 't-text-datetime' } };
    await graph.invoke({ identity: IDENTITY, subgraphState: makeReadyDraft() }, config);

    const resumed = await graph.invoke(
      new Command({ resume: { text: 'mejor el 2026-06-10 a las 11:30' } }),
      config,
    );

    expect(resumed.subgraphState.slots.date.value).toBe('2026-06-10');
    expect(resumed.subgraphState.slots.time.value).toBe('11:30');
  });
});
