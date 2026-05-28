import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ValidateRescheduleSlotResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeRescheduleValidateNode } from '../../../../../src/graph/subgraphs/reschedule/nodes/validateAvailability.js';
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

function readyDraft(): RescheduleDraftState {
  const d = initialRescheduleDraftState();
  d.slots.appointmentUuid = { value: 'apt-1', status: 'resolved' };
  d.slots.newDate = { value: '2026-06-05', status: 'resolved' };
  d.slots.newTime = { value: '14:00', status: 'resolved' };
  return d;
}

function makeGuacuco(
  impl: (input: unknown) => Promise<ValidateRescheduleSlotResult>,
): GuacucoClient {
  return { validateRescheduleSlot: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('reschedule.validate — passed=true', () => {
  it('marks exactMatch=true, phase awaiting_confirmation, lastCheckedFor snapshot', async () => {
    const guacuco = makeGuacuco(async () => ({
      passed: true,
      proposed_slots: [{ date: '2026-06-05', time: '14:00' }],
      appointment_uuid: 'apt-1',
      service_duration_minutes: 60,
    }));
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(update.availability?.exactMatch).toBe(true);
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.phase).toBe('awaiting_confirmation');
    expect(update.availability?.lastCheckedFor).toEqual({
      appointmentUuid: 'apt-1',
      newDate: '2026-06-05',
      newTime: '14:00',
    });
  });

  it('passes correct args to validateRescheduleSlot (legacy shape)', async () => {
    const fn = vi.fn(async () => ({
      passed: true,
      proposed_slots: [{ date: '2026-06-05', time: '14:00' }],
      appointment_uuid: 'apt-1',
      service_duration_minutes: 60,
    }));
    const guacuco = makeGuacuco(fn);
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(fn).toHaveBeenCalledWith({
      appointment_uuid: 'apt-1',
      profile_uuid: 'profile-1',
      date_hint: ['2026-06-05'],
      time_hint: '14:00',
    });
  });
});

describe('reschedule.validate — passed=false con suggestions', () => {
  it('populates proposedSlots from proposed_slots, phase awaiting_pick', async () => {
    const guacuco = makeGuacuco(async () => ({
      passed: false,
      proposed_slots: [
        { date: '2026-06-05', time: '15:00' },
        { date: '2026-06-05', time: '16:00' },
        { date: '2026-06-06', time: '10:00' },
      ],
      appointment_uuid: 'apt-1',
      service_duration_minutes: 60,
      fallback: {
        kind: 'selection_list',
        slot_name: 'reschedule_slot',
        header: 'h',
        button_text: 'b',
        options: [],
      },
    }));
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(update.availability?.exactMatch).toBe(false);
    expect(update.availability?.proposedSlots).toHaveLength(3);
    expect(update.availability?.proposedSlots[0]).toEqual({
      date: '2026-06-05',
      time: '15:00',
      label: '5 junio - 15:00',
    });
    expect(update.phase).toBe('awaiting_pick');
  });

  it('passed=false sin proposed_slots → exactMatch=false, lista vacía (presentOptions decide handoff)', async () => {
    const guacuco = makeGuacuco(async () => ({
      passed: false,
      proposed_slots: [],
      appointment_uuid: 'apt-1',
      service_duration_minutes: 60,
      fallback: { kind: 'text', message: 'sin disponibilidad' },
    }));
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(update.availability?.exactMatch).toBe(false);
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.phase).toBe('awaiting_pick');
  });

  it('dedupes duplicates in proposed_slots', async () => {
    const guacuco = makeGuacuco(async () => ({
      passed: false,
      proposed_slots: [
        { date: '2026-06-05', time: '15:00' },
        { date: '2026-06-05', time: '15:00' },
      ],
      appointment_uuid: 'apt-1',
      service_duration_minutes: 60,
    }));
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(update.availability?.proposedSlots).toHaveLength(1);
  });
});

describe('reschedule.validate — guards', () => {
  it('skips Guacuco call if slots unresolved → phase collecting', async () => {
    const fn = vi.fn();
    const guacuco = makeGuacuco(fn as never);
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY,
      subgraphState: initialRescheduleDraftState(),
    });
    expect(fn).not.toHaveBeenCalled();
    expect(update.phase).toBe('collecting');
  });

  it('emits terminal error when Guacuco throws', async () => {
    const guacuco = makeGuacuco(async () => {
      throw new Error('upstream 500');
    });
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });

  it('fails if identity.profileUuid is missing', async () => {
    const fn = vi.fn();
    const guacuco = makeGuacuco(fn as never);
    const node = makeRescheduleValidateNode({ guacuco, logger: mockLogger });
    const update = await node({
      identity: { ...IDENTITY, profileUuid: '' },
      subgraphState: readyDraft(),
    });
    expect(fn).not.toHaveBeenCalled();
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });
});
