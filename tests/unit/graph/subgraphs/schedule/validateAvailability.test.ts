import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ToolValidateResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeValidateAvailabilityNode } from '../../../../../src/graph/subgraphs/schedule/nodes/validateAvailability.js';
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

function makeReadyDraft(): AppointmentDraftState {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-corte'], status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  return d;
}

function makeGuacuco(impl: (input: unknown) => Promise<ToolValidateResult>): GuacucoClient {
  return { validateScheduleSlot: impl } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('validateAvailability — happy path', () => {
  it('on valid=true: marks exactMatch=true, no proposedSlots, phase awaiting_confirmation', async () => {
    const guacuco = makeGuacuco(async () => ({ valid: true, results: [] }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.exactMatch).toBe(true);
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.phase).toBe('awaiting_confirmation');
    expect(update.availability?.lastCheckedFor).toEqual({
      date: '2026-05-28',
      time: '16:00',
      staffUuid: 'stf-maria',
      serviceUuids: ['svc-corte'],
    });
  });

  it('passes correct params to guacuco.validateScheduleSlot', async () => {
    const fn = vi.fn(async () => ({ valid: true, results: [] }) as ToolValidateResult);
    const guacuco = makeGuacuco(fn);
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(fn).toHaveBeenCalledWith({
      date: '2026-05-28',
      appointment_time: '16:00',
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-maria',
      service_uuids: ['svc-corte'],
    });
  });
});

describe('validateAvailability — no match with suggestions', () => {
  it('populates proposedSlots from suggestions.combined', async () => {
    const guacuco = makeGuacuco(async () => ({
      valid: false,
      results: [],
      suggestions: {
        combined: ['2026-05-28 17:00', '2026-05-28 18:00', '2026-05-29 10:00'],
      },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.exactMatch).toBe(false);
    expect(update.availability?.proposedSlots).toHaveLength(3);
    expect(update.availability?.proposedSlots[0]).toEqual({
      date: '2026-05-28',
      time: '17:00',
      label: '28 mayo - 17:00',
    });
    expect(update.phase).toBe('awaiting_pick');
  });

  it('handles ISO format with T separator in combined', async () => {
    const guacuco = makeGuacuco(async () => ({
      valid: false,
      results: [],
      suggestions: { combined: ['2026-06-01T09:30'] },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.proposedSlots[0]).toEqual({
      date: '2026-06-01',
      time: '09:30',
      label: '1 junio - 09:30',
    });
  });

  it('falls back to date[] only suggestions (keeps original time)', async () => {
    const guacuco = makeGuacuco(async () => ({
      valid: false,
      results: [],
      suggestions: { date: ['2026-06-01', '2026-06-02'] },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.proposedSlots).toEqual([
      { date: '2026-06-01', time: '16:00', label: '1 junio - 16:00' },
      { date: '2026-06-02', time: '16:00', label: '2 junio - 16:00' },
    ]);
  });

  it('dedupes duplicates across combined + date + time arrays', async () => {
    const guacuco = makeGuacuco(async () => ({
      valid: false,
      results: [],
      suggestions: {
        combined: ['2026-05-28 17:00'],
        appointment_time: ['17:00'], // same date+time → dedup
      },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.proposedSlots).toHaveLength(1);
  });
});

describe('validateAvailability — guard rails', () => {
  it('skips Guacuco call if slots unresolved', async () => {
    const fn = vi.fn();
    const guacuco = makeGuacuco(fn as never);
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({
      identity: IDENTITY,
      subgraphState: initialAppointmentDraftState('client'),
    });
    expect(fn).not.toHaveBeenCalled();
    expect(update.phase).toBe('collecting');
  });

  it('emits terminal error_outcome when Guacuco throws', async () => {
    const guacuco = makeGuacuco(async () => {
      throw new Error('upstream 500');
    });
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });

  it('fails if tenantAlliaId is missing', async () => {
    const fn = vi.fn();
    const guacuco = makeGuacuco(fn as never);
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({
      identity: { ...IDENTITY, tenantAlliaId: '' },
      subgraphState: makeReadyDraft(),
    });
    expect(fn).not.toHaveBeenCalled();
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });
});
