import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ConfirmAppointmentResult } from '../../../../../src/clients/types/GuacucoTypes.js';
import { IdpError } from '../../../../../src/core/errors/IdpError.js';
import { ToolExecutionError } from '../../../../../src/core/errors/ToolExecutionError.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeConfirmCommitNode } from '../../../../../src/graph/subgraphs/confirm/nodes/commit.js';
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

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function readyDraft(): ConfirmDraftState {
  const d = initialConfirmDraftState();
  d.slots.appointmentUuid = { value: 'apt-1', displayName: 'Corte', status: 'resolved' };
  d.phase = 'committing';
  return d;
}

function makeGuacuco(
  fn: (params: unknown, opts?: unknown) => Promise<ConfirmAppointmentResult>,
): GuacucoClient {
  return { confirmAppointment: fn } as unknown as GuacucoClient;
}

function successResult(): ConfirmAppointmentResult {
  return {
    response_type: 'text',
    message: 'ok',
    appointment_uuid: 'apt-1',
    status: 1,
  };
}

afterEach(() => vi.clearAllMocks());

describe('confirm.commit', () => {
  it('happy: phase=done, llama confirmAppointment con uuid + idempotencyKey', async () => {
    const fn = vi.fn(async () => successResult());
    const node = makeConfirmCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });

    expect(out.phase).toBe('done');
    expect(fn).toHaveBeenCalledOnce();
    const [params, identity, opts] = fn.mock.calls[0] ?? [];
    expect(params).toEqual({ appointment_uuid: 'apt-1' });
    expect(identity).toEqual(IDENTITY);
    expect((opts as { idempotencyKey?: string })?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('anti-alucinación: slot no resolved lanza IdpError', async () => {
    const draft = readyDraft();
    draft.slots.appointmentUuid = { status: 'empty' };
    const fn = vi.fn();
    const node = makeConfirmCommitNode({
      guacuco: makeGuacuco(fn as never),
      logger: mockLogger,
    });
    await expect(node({ identity: IDENTITY, subgraphState: draft })).rejects.toBeInstanceOf(
      IdpError,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('APPOINTMENT_ALREADY_CONFIRMED → silent success (idempotencia)', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('APPOINTMENT_ALREADY_CONFIRMED', 'already');
    });
    const node = makeConfirmCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.phase).toBe('done');
    expect(out.terminalOutcome).toBeUndefined();
  });

  it('APPOINTMENT_NOT_FOUND → error terminal', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('APPOINTMENT_NOT_FOUND', 'gone');
    });
    const node = makeConfirmCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.phase).toBe('failed');
    expect(out.terminalOutcome?.action).toBe('error');
    expect(out.terminalOutcome?.pendingReply?.text).toMatch(/cancelado|no encontr/i);
  });

  it('unknown ToolExecutionError → handed_off', async () => {
    const fn = vi.fn(async () => {
      throw new ToolExecutionError('SOMETHING_NEW', 'msg');
    });
    const node = makeConfirmCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.terminalOutcome?.action).toBe('handed_off');
  });

  it('network error → error terminal', async () => {
    const fn = vi.fn(async () => {
      throw new Error('econnreset');
    });
    const node = makeConfirmCommitNode({ guacuco: makeGuacuco(fn), logger: mockLogger });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.terminalOutcome?.action).toBe('error');
  });
});
