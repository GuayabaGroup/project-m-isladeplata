import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CrmContext } from '../../../../../src/core/types/CrmContext.js';
import { makeConfirmBootstrapNode } from '../../../../../src/graph/subgraphs/confirm/nodes/bootstrap.js';
import { initialConfirmDraftState } from '../../../../../src/graph/subgraphs/confirm/state.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function crmWith(count: number): CrmContext {
  return {
    upcomingAppointments: Array.from({ length: count }, (_, i) => ({
      appointmentUuid: `apt-${i + 1}`,
      description: `Turno ${i + 1}`,
      startAt: `2026-05-${28 + i}T16:00`,
    })),
    profileMeta: {},
  };
}

describe('confirm.bootstrap', () => {
  it('0 upcomings → terminalOutcome=response, phase=failed', () => {
    const node = makeConfirmBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(0), subgraphState: initialConfirmDraftState() });
    expect(out.phase).toBe('failed');
    expect(out.terminalOutcome?.action).toBe('response');
    expect(out.terminalOutcome?.pendingReply?.text).toMatch(/no ten[ée]s turnos/i);
  });

  it('1 upcoming → pre-fill slot resolved, phase=committing', () => {
    const node = makeConfirmBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(1), subgraphState: initialConfirmDraftState() });
    expect(out.phase).toBe('committing');
    expect(out.slots?.appointmentUuid?.value).toBe('apt-1');
    expect(out.slots?.appointmentUuid?.status).toBe('resolved');
    expect(out.slots?.appointmentUuid?.displayName).toBe('Turno 1');
  });

  it('2+ upcomings → phase=collecting (ask_slot pedirá)', () => {
    const node = makeConfirmBootstrapNode({ logger: mockLogger });
    const out = node({ crmContext: crmWith(3), subgraphState: initialConfirmDraftState() });
    expect(out.phase).toBe('collecting');
    expect(out.slots).toBeUndefined();
  });
});
