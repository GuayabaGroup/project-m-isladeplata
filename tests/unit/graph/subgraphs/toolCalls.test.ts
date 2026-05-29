import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../src/clients/GuacucoClient.js';
import type { ConfirmAppointmentResult } from '../../../../src/clients/types/GuacucoTypes.js';
import { ToolExecutionError } from '../../../../src/core/errors/ToolExecutionError.js';
import type { ChannelMessage } from '../../../../src/core/types/ChannelMessage.js';
import type { Identity } from '../../../../src/core/types/Identity.js';
import type { ToolCallRecord } from '../../../../src/core/types/ToolCall.js';
import { makeSubgraphFinalizeNode } from '../../../../src/graph/subgraphs/common/finalize.js';
import { mergeSubgraphMeta, withToolCall } from '../../../../src/graph/subgraphs/common/state.js';
import { makeConfirmCommitNode } from '../../../../src/graph/subgraphs/confirm/nodes/commit.js';
import {
  type ConfirmDraftState,
  initialConfirmDraftState,
} from '../../../../src/graph/subgraphs/confirm/state.js';
import { ConversationPersister } from '../../../../src/pregraph/ConversationPersister.js';

const logger = {
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
  platformId: 3,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function readyDraft(): ConfirmDraftState {
  const d = initialConfirmDraftState();
  d.slots.appointmentUuid = { value: 'apt-1', displayName: 'Corte', status: 'resolved' };
  d.phase = 'committing';
  return d;
}

function guacucoWith(fn: () => Promise<ConfirmAppointmentResult>): GuacucoClient {
  return { confirmAppointment: vi.fn(fn) } as unknown as GuacucoClient;
}

describe('mergeSubgraphMeta', () => {
  it('suma attempts, appendea recoverableErrors y toolCalls', () => {
    const rec: ToolCallRecord = { toolName: 'x', input: {}, resultStatus: 'ok' };
    const merged = mergeSubgraphMeta(
      { attempts: 1, recoverableErrors: ['A'], toolCalls: [rec] },
      { attempts: 1, recoverableErrors: ['B'], toolCalls: [{ ...rec, toolName: 'y' }] },
    );
    expect(merged.attempts).toBe(2);
    expect(merged.recoverableErrors).toEqual(['A', 'B']);
    expect(merged.toolCalls?.map((t) => t.toolName)).toEqual(['x', 'y']);
  });

  it('omite toolCalls cuando no hay ninguno', () => {
    const merged = mergeSubgraphMeta({ attempts: 0, recoverableErrors: [] }, undefined);
    expect(merged.toolCalls).toBeUndefined();
  });
});

describe('withToolCall', () => {
  it('agrega el record al meta delta preservando recoverableErrors', () => {
    const partial = withToolCall(
      { phase: 'failed', meta: { attempts: 0, recoverableErrors: ['CODE'] } },
      { toolName: 'cancel_appointment', input: { appointment_uuid: 'a' }, resultStatus: 'error' },
    );
    expect(partial.meta?.recoverableErrors).toEqual(['CODE']);
    expect(partial.meta?.toolCalls).toHaveLength(1);
    expect(partial.meta?.toolCalls?.[0]?.toolName).toBe('cancel_appointment');
  });
});

describe('commit registra tool_calls', () => {
  it('success → meta.toolCalls con resultStatus ok', async () => {
    const node = makeConfirmCommitNode({
      guacuco: guacucoWith(async () => ({
        response_type: 'text',
        message: 'ok',
        appointment_uuid: 'apt-1',
        status: 1,
      })),
      logger,
    });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.phase).toBe('done');
    expect(out.meta?.toolCalls).toEqual([
      { toolName: 'confirm_appointment', input: { appointment_uuid: 'apt-1' }, resultStatus: 'ok' },
    ]);
  });

  it('error → meta.toolCalls con resultStatus error + errorCode', async () => {
    const node = makeConfirmCommitNode({
      guacuco: guacucoWith(async () => {
        throw new ToolExecutionError('APPOINTMENT_NOT_FOUND', 'gone');
      }),
      logger,
    });
    const out = await node({ identity: IDENTITY, subgraphState: readyDraft() });
    expect(out.phase).toBe('failed');
    expect(out.meta?.toolCalls).toEqual([
      {
        toolName: 'confirm_appointment',
        input: { appointment_uuid: 'apt-1' },
        resultStatus: 'error',
        errorCode: 'APPOINTMENT_NOT_FOUND',
      },
    ]);
  });
});

describe('finalize propaga toolCalls al outcome', () => {
  it('copia meta.toolCalls al outcome global', () => {
    const finalize = makeSubgraphFinalizeNode({ logger });
    const toolCalls: ToolCallRecord[] = [
      { toolName: 'schedule_appointment', input: { date: '2026-05-28' }, resultStatus: 'ok' },
    ];
    const update = finalize({
      subgraphState: {
        __kind: 'schedule',
        phase: 'done',
        terminalOutcome: { action: 'response', pendingReply: { text: 'Listo' } },
        meta: { attempts: 1, recoverableErrors: [], toolCalls },
      },
      input: null,
    });
    expect(update.outcome?.toolCalls).toEqual(toolCalls);
  });

  it('no agrega toolCalls cuando no hubo ninguno', () => {
    const finalize = makeSubgraphFinalizeNode({ logger });
    const update = finalize({
      subgraphState: {
        __kind: 'query',
        phase: 'done',
        terminalOutcome: { action: 'response', pendingReply: { text: 'hola' } },
        meta: { attempts: 0, recoverableErrors: [] },
      },
      input: null,
    });
    expect(update.outcome?.toolCalls).toBeUndefined();
  });
});

describe('ConversationPersister mapea toolCalls al shape Guacuco', () => {
  const identity: Identity = {
    tenantUuid: 'biz-1',
    tenantAlliaId: 'allia-1',
    profileUuid: 'cli-1',
    profileType: 'client',
    platformId: 1,
    channel: 'whatsapp',
    timezone: 'America/Argentina/Buenos_Aires',
  };
  const message = {
    channelType: 'whatsapp',
    channelId: 'c',
    messageId: 'm',
    contentText: 'cancelá mi turno',
    receivedAt: '2026-05-28T10:00:00Z',
    channelMeta: { phoneNumberId: 'pn', role: 'client' },
    interactivePayload: null,
  } as ChannelMessage;

  it('camelCase → snake_case con error_code', () => {
    const persister = new ConversationPersister({} as unknown as GuacucoClient, logger);
    const payload = persister.buildPayload(
      message,
      identity,
      { action: 'response', pendingReply: { text: 'Listo, cancelado.' } },
      {
        subgraph: 'cancel',
        toolCalls: [
          {
            toolName: 'cancel_appointment',
            input: { appointment_uuid: 'apt-1' },
            resultStatus: 'error',
            errorCode: 'APPOINTMENT_NOT_FOUND',
          },
        ],
      },
    );
    const assistant = payload.turns.find((t) => t.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([
      {
        tool_name: 'cancel_appointment',
        input: { appointment_uuid: 'apt-1' },
        result_status: 'error',
        error_code: 'APPOINTMENT_NOT_FOUND',
      },
    ]);
  });
});
