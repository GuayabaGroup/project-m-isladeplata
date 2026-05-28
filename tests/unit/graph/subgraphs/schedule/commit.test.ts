import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ScheduleAppointmentResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import { IdpError } from '../../../../../src/core/errors/IdpError.js';
import { ToolExecutionError } from '../../../../../src/core/errors/ToolExecutionError.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeCommitNode } from '../../../../../src/graph/subgraphs/schedule/nodes/commit.js';
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
  profileUuid: 'profile-client-uuid',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const IDENTITY_STAFF: Identity = {
  ...IDENTITY_CLIENT,
  profileUuid: 'profile-staff-uuid',
  profileType: 'staff',
};

const KNOWN_UUID = '11111111-2222-3333-4444-555555555555';

function makeReadyDraft(profileType: 'client' | 'staff' = 'client'): AppointmentDraftState {
  const d = initialAppointmentDraftState(profileType);
  d.slots.services = { value: ['svc-corte'], displayName: 'Corte', status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', displayName: 'María', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  if (profileType === 'staff') {
    d.slots.clientUuid = { value: 'real-client-uuid', status: 'resolved' };
  }
  d.confirmation = {
    intentUuid: KNOWN_UUID,
    message: 'msg',
    requestedAt: '2026-05-27T12:00:00Z',
  };
  d.phase = 'committing';
  return d;
}

function makeSuccessResult(): ScheduleAppointmentResult {
  return {
    response_type: 'text',
    message: 'ok',
    appointment_uuid: 'apt-1',
    business_uuid: 'biz-1',
    client_uuid: 'profile-client-uuid',
    appointment_date: '2026-05-28',
    start_time: '16:00',
    end_time: '17:00',
    status: 1,
    staff_assignments: [],
  };
}

function makeGuacuco(
  fn: (params: unknown, opts?: unknown) => Promise<ScheduleAppointmentResult>,
): GuacucoClient {
  return { scheduleAppointment: fn } as unknown as GuacucoClient;
}

afterEach(() => vi.clearAllMocks());

describe('commit — happy path', () => {
  it('on client success: phase=done, passes idempotencyKey + correct params', async () => {
    const fn = vi.fn(async () => makeSuccessResult());
    const guacuco = makeGuacuco(fn);
    const node = makeCommitNode({ guacuco, logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('done');
    expect(fn).toHaveBeenCalledWith(
      {
        business_allia_id: 'allia-1',
        date: '2026-05-28',
        appointment_time: '16:00',
        client_uuid: 'profile-client-uuid', // from identity
        staff_uuid: 'stf-maria',
        service_uuids: ['svc-corte'],
      },
      { idempotencyKey: KNOWN_UUID },
    );
  });

  it('on staff role: client_uuid comes from slots.clientUuid.value (not identity)', async () => {
    const fn = vi.fn(async () => makeSuccessResult());
    const guacuco = makeGuacuco(fn);
    const node = makeCommitNode({ guacuco, logger: mockLogger });

    await node({ identity: IDENTITY_STAFF, subgraphState: makeReadyDraft('staff') });
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ client_uuid: 'real-client-uuid' }),
      expect.any(Object),
    );
  });
});

describe('commit — anti-alucinación (assertSlotsResolved)', () => {
  it('throws IdpError when slot not resolved (router bug guard)', async () => {
    const draft = makeReadyDraft();
    draft.slots.staff = { status: 'empty' };
    const fn = vi.fn();
    const guacuco = makeGuacuco(fn as never);
    const node = makeCommitNode({ guacuco, logger: mockLogger });

    await expect(node({ identity: IDENTITY_CLIENT, subgraphState: draft })).rejects.toBeInstanceOf(
      IdpError,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('commit — error handling', () => {
  it('STAFF_NOT_AVAILABLE (first time) → recoverable, phase=validating, clears availability + confirmation', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('STAFF_NOT_AVAILABLE', 'slot taken');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('validating_availability');
    expect(update.availability?.proposedSlots).toEqual([]);
    expect(update.confirmation).toEqual({});
    expect(update.meta?.recoverableErrors).toContain('STAFF_NOT_AVAILABLE');
  });

  it('STAFF_NOT_AVAILABLE (second time, already retried) → handed_off', async () => {
    const draft = makeReadyDraft();
    draft.meta.recoverableErrors = ['STAFF_NOT_AVAILABLE'];
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('STAFF_NOT_AVAILABLE', 'slot taken again');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });

  it('BUSINESS_MISMATCH → no-recoverable terminalOutcome=error, phase=failed', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('BUSINESS_MISMATCH', 'mismatch');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });

  it('IDEMPOTENT_REQUEST_IN_PROGRESS → handed_off with informative message', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('IDEMPOTENT_REQUEST_IN_PROGRESS', 'in progress');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/procesada|procesando|reserva/i);
  });

  it('unknown ToolExecutionError code → handed_off', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('SOME_NEW_CODE', 'unknown');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });

  it('network error (non-ToolExecutionError) → terminalOutcome=error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const node = makeCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });

    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: makeReadyDraft() });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });
});

describe('commit — staff role missing clientUuid value', () => {
  it('staff with clientUuid only as userPhrase (no value) → handed_off without calling Guacuco', async () => {
    const draft = makeReadyDraft('staff');
    // Simulate v1 scope: text-only client identification, no resolved value
    draft.slots.clientUuid = { userPhrase: 'Ana Lopez 1144556677', status: 'guessed' };
    const fn = vi.fn();
    const node = makeCommitNode({ guacuco: makeGuacuco(fn as never), logger: mockLogger });

    // assertSlotsResolved should throw first because clientUuid is not resolved.
    await expect(node({ identity: IDENTITY_STAFF, subgraphState: draft })).rejects.toBeInstanceOf(
      IdpError,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('commit — missing intentUuid', () => {
  it('returns error when confirmation.intentUuid missing', async () => {
    const draft = makeReadyDraft();
    draft.confirmation = {};
    const fn = vi.fn();
    const node = makeCommitNode({ guacuco: makeGuacuco(fn as never), logger: mockLogger });
    const update = await node({ identity: IDENTITY_CLIENT, subgraphState: draft });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
    expect(fn).not.toHaveBeenCalled();
  });
});
