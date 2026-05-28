import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { CheckAvailabilityResult } from '../../../../../src/clients/types/GuacucoTypes.js';
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

function makeGuacuco(impl: (input: unknown) => Promise<CheckAvailabilityResult>): GuacucoClient {
  return { checkAvailability: impl } as unknown as GuacucoClient;
}

function availableResult(): CheckAvailabilityResult {
  return {
    response_type: 'text',
    message: 'OK',
    available: true,
    date: '2026-05-28',
    start_time: '16:00',
    end_time: '17:00',
    staff_uuid: 'stf-maria',
    service_uuids: ['svc-corte'],
    total_duration_minutes: 60,
    suggestions: { schedule_appointment: [] },
  };
}

afterEach(() => vi.clearAllMocks());

describe('validateAvailability — happy path', () => {
  it('on available=true: marks exactMatch=true, no proposedSlots, phase awaiting_confirmation', async () => {
    const guacuco = makeGuacuco(async () => availableResult());
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

  it('passes correct params to guacuco.checkAvailability (Mode A)', async () => {
    const fn = vi.fn(async () => availableResult());
    const guacuco = makeGuacuco(fn);
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(fn).toHaveBeenCalledWith({
      business_allia_id: 'allia-1',
      staff_uuid: 'stf-maria',
      service_uuids: ['svc-corte'],
      date: '2026-05-28',
      appointment_time: '16:00',
    });
  });
});

describe('validateAvailability — no match with suggestions', () => {
  it('populates proposedSlots from suggestions.schedule_appointment', async () => {
    const guacuco = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'busy',
      available: false,
      reason: 'STAFF_NOT_AVAILABLE',
      suggestions: {
        schedule_appointment: [
          {
            service_uuids: ['svc-corte'],
            staff_uuid: 'stf-maria',
            date: '2026-05-28',
            appointment_time: '17:00',
            label: '28 mayo - 17:00',
          },
          {
            service_uuids: ['svc-corte'],
            staff_uuid: 'stf-maria',
            date: '2026-05-29',
            appointment_time: '10:00',
            label: '29 mayo - 10:00',
          },
        ],
      },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });

    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.exactMatch).toBe(false);
    expect(update.availability?.proposedSlots).toHaveLength(2);
    expect(update.availability?.proposedSlots[0]).toEqual({
      date: '2026-05-28',
      time: '17:00',
      label: '28 mayo - 17:00',
    });
    expect(update.phase).toBe('awaiting_pick');
  });

  it('falls back to formatLabel when suggestion.label is empty', async () => {
    const guacuco = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'busy',
      available: false,
      suggestions: {
        schedule_appointment: [
          {
            service_uuids: ['svc-corte'],
            staff_uuid: 'stf-maria',
            date: '2026-06-01',
            appointment_time: '09:30',
            label: '',
          },
        ],
      },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.proposedSlots[0]).toEqual({
      date: '2026-06-01',
      time: '09:30',
      label: '1 junio - 09:30',
    });
  });

  it('dedupes duplicate date+time suggestions', async () => {
    const guacuco = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'busy',
      available: false,
      suggestions: {
        schedule_appointment: [
          {
            service_uuids: ['svc-corte'],
            staff_uuid: 'stf-maria',
            date: '2026-05-28',
            appointment_time: '17:00',
            label: '28 mayo - 17:00',
          },
          {
            service_uuids: ['svc-corte'],
            staff_uuid: 'stf-maria',
            date: '2026-05-28',
            appointment_time: '17:00',
            label: '28 mayo - 17:00 (dup)',
          },
        ],
      },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.proposedSlots).toHaveLength(1);
  });

  it('handles empty suggestions list', async () => {
    const guacuco = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'busy',
      available: false,
      suggestions: { schedule_appointment: [] },
    }));
    const node = makeValidateAvailabilityNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY, subgraphState: makeReadyDraft() });
    expect(update.availability?.exactMatch).toBe(false);
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.phase).toBe('awaiting_pick');
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
