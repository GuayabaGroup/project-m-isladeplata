import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import type { Outcome } from '../../../src/core/types/Outcome.js';
import {
  metricsRegistry,
  resetMetrics,
} from '../../../src/infrastructure/observability/metrics.js';
import { ConversationPersister } from '../../../src/pregraph/ConversationPersister.js';

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const all = await metricsRegistry.getMetricsAsJSON();
  const found = all.find((m) => m.name === name);
  if (!found?.values) return 0;
  for (const v of found.values) {
    const match = Object.entries(labels).every(([k, val]) => v.labels?.[k] === val);
    if (match) return Number(v.value);
  }
  return 0;
}

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeIdentity(overrides?: Partial<Identity>): Identity {
  return {
    tenantUuid: 'biz-1',
    tenantAlliaId: 'allia-1',
    profileUuid: 'cli-1',
    profileType: 'client',
    platformId: 1,
    channel: 'whatsapp',
    timezone: 'America/Argentina/Buenos_Aires',
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: 'wamid.ABC',
    contentType: 'text',
    contentText: 'quiero un turno',
    receivedAt: '2026-05-27T15:30:00Z',
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
    interactivePayload: null,
    ...overrides,
  };
}

describe('ConversationPersister.buildPayload', () => {
  it('builds payload with user + assistant turns from text reply', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const outcome: Outcome = {
      action: 'response',
      pendingReply: { text: 'Hola, ¿en qué puedo ayudarte?' },
    };

    const payload = persister.buildPayload(makeMessage(), makeIdentity(), outcome, {
      subgraph: 'schedule',
    });

    expect(payload.tenant_allia_id).toBe('allia-1');
    expect(payload.thread_id).toBe('biz-1:cli-1:whatsapp:1');
    expect(payload.profile_uuid).toBe('cli-1');
    expect(payload.profile_type).toBe('client');
    expect(payload.platform_id).toBe(1);
    expect(payload.channel).toBe('whatsapp');
    expect(payload.turn_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.turns).toHaveLength(2);

    const user = payload.turns[0];
    expect(user?.role).toBe('user');
    expect(user?.content).toBe('quiero un turno');
    if (user?.role === 'user') {
      expect(user.received_at).toBe('2026-05-27T15:30:00Z');
      expect(user.metadata?.message_id).toBe('wamid.ABC');
    }

    const assistant = payload.turns[1];
    expect(assistant?.role).toBe('assistant');
    if (assistant?.role === 'assistant') {
      expect(assistant.content).toBe('Hola, ¿en qué puedo ayudarte?');
      expect(assistant.outcome_action).toBe('response');
      expect(assistant.subgraph).toBe('schedule');
      expect(assistant.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('omits assistant turn when outcome has no pendingReply (ignored / silent)', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const payload = persister.buildPayload(makeMessage(), makeIdentity(), { action: 'ignored' });

    expect(payload.turns).toHaveLength(1);
    expect(payload.turns[0]?.role).toBe('user');
  });

  it('renders buttons reply as text-with-bracketed-buttons', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const outcome: Outcome = {
      action: 'awaiting_user',
      pendingReply: {
        text: '¿Confirmás el turno?',
        buttons: [
          { id: 'confirm:abc', title: 'Sí' },
          { id: 'cancel:abc', title: 'No' },
        ],
      },
    };

    const payload = persister.buildPayload(makeMessage(), makeIdentity(), outcome);
    const assistant = payload.turns[1];
    expect(assistant?.role).toBe('assistant');
    if (assistant?.role === 'assistant') {
      expect(assistant.content).toContain('¿Confirmás el turno?');
      expect(assistant.content).toContain('[Sí]');
      expect(assistant.content).toContain('[No]');
    }
  });

  it('renders list reply as body + bulleted rows', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const outcome: Outcome = {
      action: 'awaiting_user',
      pendingReply: {
        list: {
          body: 'Elegí un horario',
          buttonLabel: 'Ver',
          rows: [
            { id: 'slot-1', title: 'Lunes 10:00', description: 'María' },
            { id: 'slot-2', title: 'Martes 14:00' },
          ],
        },
      },
    };

    const payload = persister.buildPayload(makeMessage(), makeIdentity(), outcome);
    const assistant = payload.turns[1];
    if (assistant?.role === 'assistant') {
      expect(assistant.content).toContain('Elegí un horario');
      expect(assistant.content).toContain('- Lunes 10:00 — María');
      expect(assistant.content).toContain('- Martes 14:00');
    }
  });

  it('renders cta reply with display text + url', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const outcome: Outcome = {
      action: 'response',
      pendingReply: {
        cta: {
          text: 'Bienvenido Juan',
          url: 'https://onboard.example/x',
          displayText: 'Comenzar',
        },
      },
    };

    const payload = persister.buildPayload(makeMessage(), makeIdentity(), outcome);
    const assistant = payload.turns[1];
    if (assistant?.role === 'assistant') {
      expect(assistant.content).toContain('Bienvenido Juan');
      expect(assistant.content).toContain('[Comenzar](https://onboard.example/x)');
    }
  });

  it('masks PII in both user and assistant content', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const message = makeMessage({ contentText: 'mi mail es juan@example.com tel 1123456789' });
    const outcome: Outcome = {
      action: 'response',
      pendingReply: { text: 'Te confirmo a juan@example.com tel 1123456789' },
    };

    const payload = persister.buildPayload(message, makeIdentity(), outcome);

    expect(payload.turns[0]?.content).not.toContain('juan@example.com');
    expect(payload.turns[0]?.content).not.toContain('1123456789');
    expect(payload.turns[1]?.content).not.toContain('juan@example.com');
    expect(payload.turns[1]?.content).not.toContain('1123456789');
  });

  it('preserves interactive_payload when message comes from button tap', () => {
    const persister = new ConversationPersister(
      { persistAgentTurns: vi.fn() } as unknown as GuacucoClient,
      mockLogger,
    );

    const message = makeMessage({
      contentText: '',
      interactivePayload: { type: 'button', id: 'confirm:abc-123', title: 'Sí' },
    });

    const payload = persister.buildPayload(message, makeIdentity(), { action: 'ignored' });
    const user = payload.turns[0];
    if (user?.role === 'user') {
      expect(user.metadata?.interactive_payload).toEqual({
        type: 'button',
        id: 'confirm:abc-123',
        title: 'Sí',
      });
    }
  });
});

describe('ConversationPersister.persistTurn', () => {
  beforeEach(() => resetMetrics());

  it('calls guacuco.persistAgentTurns with the built payload', async () => {
    const persistAgentTurns = vi.fn().mockResolvedValue({ turn_id: 'whatever', persisted: true });
    const persister = new ConversationPersister(
      { persistAgentTurns } as unknown as GuacucoClient,
      mockLogger,
    );

    await persister.persistTurn(makeMessage(), makeIdentity(), {
      action: 'response',
      pendingReply: { text: 'ok' },
    });

    expect(persistAgentTurns).toHaveBeenCalledTimes(1);
    const payload = persistAgentTurns.mock.calls[0]?.[0];
    expect(payload.thread_id).toBe('biz-1:cli-1:whatsapp:1');
    expect(payload.turns).toHaveLength(2);
  });

  it('increments persist_turn_total{result=ok} on successful POST', async () => {
    const persistAgentTurns = vi.fn().mockResolvedValue({ turn_id: 'x', persisted: true });
    const persister = new ConversationPersister(
      { persistAgentTurns } as unknown as GuacucoClient,
      mockLogger,
    );

    await persister.persistTurn(makeMessage(), makeIdentity(), { action: 'ignored' });
    expect(await metricValue('isladeplata_persist_turn_total', { result: 'ok' })).toBe(1);
    expect(await metricValue('isladeplata_persist_turn_total', { result: 'error' })).toBe(0);
  });

  it('increments persist_turn_total{result=error} when guacuco throws', async () => {
    const persistAgentTurns = vi.fn().mockRejectedValue(new Error('guacuco offline'));
    const persister = new ConversationPersister(
      { persistAgentTurns } as unknown as GuacucoClient,
      mockLogger,
    );

    await persister.persistTurn(makeMessage(), makeIdentity(), { action: 'ignored' });
    expect(await metricValue('isladeplata_persist_turn_total', { result: 'error' })).toBe(1);
  });

  it('swallows errors from guacuco — never throws', async () => {
    const persistAgentTurns = vi.fn().mockRejectedValue(new Error('guacuco offline'));
    const persister = new ConversationPersister(
      { persistAgentTurns } as unknown as GuacucoClient,
      mockLogger,
    );

    await expect(
      persister.persistTurn(makeMessage(), makeIdentity(), { action: 'ignored' }),
    ).resolves.toBeUndefined();
  });
});
