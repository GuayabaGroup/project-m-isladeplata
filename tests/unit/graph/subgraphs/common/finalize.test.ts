import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Outcome } from '../../../../../src/core/types/Outcome.js';
import { makeSubgraphFinalizeNode } from '../../../../../src/graph/subgraphs/common/finalize.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function inputWith(text: string) {
  return {
    channelMessage: {
      channelType: 'whatsapp' as const,
      channelId: 'c',
      messageId: 'm',
      contentType: 'text' as const,
      contentText: text,
      receivedAt: '2026-05-28T10:00:00Z',
      whatsappChannel: 'client' as const,
      phoneNumberId: 'pn',
      interactivePayload: null,
    },
  };
}

describe('subgraphFinalize — historial', () => {
  it('appends [Human, AI] when there is a user question and a text reply', () => {
    const finalize = makeSubgraphFinalizeNode({ logger });
    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text: 'Tenés 2 turnos.' },
    };
    const update = finalize({
      subgraphState: { __kind: 'query', phase: 'done', terminalOutcome },
      input: inputWith('¿cuántos turnos tengo?'),
    });
    expect(update.messages).toHaveLength(2);
    const [human, ai] = update.messages as [HumanMessage, AIMessage];
    expect(human).toBeInstanceOf(HumanMessage);
    expect(human.content).toBe('¿cuántos turnos tengo?');
    expect(ai).toBeInstanceOf(AIMessage);
    expect(ai.content).toBe('Tenés 2 turnos.');
    // Sigue limpiando el subgraphState + routing.
    expect(update.subgraphState).toBeNull();
  });

  it('does not append messages when the outcome has no text reply', () => {
    const finalize = makeSubgraphFinalizeNode({ logger });
    const update = finalize({
      subgraphState: { __kind: 'cancel', phase: 'done', terminalOutcome: { action: 'ignored' } },
      input: inputWith('algo'),
    });
    expect(update.messages).toBeUndefined();
  });

  it('does not append when there is no user input text', () => {
    const finalize = makeSubgraphFinalizeNode({ logger });
    const terminalOutcome: Outcome = { action: 'response', pendingReply: { text: 'hola' } };
    const update = finalize({
      subgraphState: { __kind: 'query', phase: 'done', terminalOutcome },
      input: inputWith(''),
    });
    expect(update.messages).toBeUndefined();
  });
});
