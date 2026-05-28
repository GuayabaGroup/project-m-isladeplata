import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_TURNS,
  buildConversationHistory,
  historyLooksLikeDrilldown,
} from '../../../../../src/graph/subgraphs/query/conversationHistory.js';

describe('buildConversationHistory', () => {
  it('returns undefined for empty/undefined input', () => {
    expect(buildConversationHistory(undefined)).toBeUndefined();
    expect(buildConversationHistory([])).toBeUndefined();
  });

  it('maps human→user and ai→assistant', () => {
    const history = buildConversationHistory([
      new HumanMessage('¿cuántos turnos tengo?'),
      new AIMessage('Tenés 2 turnos.'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: '¿cuántos turnos tengo?' },
      { role: 'assistant', content: 'Tenés 2 turnos.' },
    ]);
  });

  it('skips non human/ai messages (system)', () => {
    const history = buildConversationHistory([
      new SystemMessage('sos un agente'),
      new HumanMessage('hola'),
    ]);
    expect(history).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('drops empty/whitespace-only entries', () => {
    const history = buildConversationHistory([new AIMessage('   '), new HumanMessage('algo')]);
    expect(history).toEqual([{ role: 'user', content: 'algo' }]);
  });

  it('caps to the last MAX_HISTORY_TURNS', () => {
    const msgs = Array.from({ length: MAX_HISTORY_TURNS + 4 }, (_, i) =>
      i % 2 === 0 ? new HumanMessage(`u${i}`) : new AIMessage(`a${i}`),
    );
    const history = buildConversationHistory(msgs);
    expect(history).toHaveLength(MAX_HISTORY_TURNS);
    // El primer turno conservado es el (length - MAX) — los viejos se descartan.
    expect(history?.[0]?.content).toBe(`u${4}`);
  });
});

describe('historyLooksLikeDrilldown', () => {
  it('is false for undefined/empty', () => {
    expect(historyLooksLikeDrilldown(undefined)).toBe(false);
    expect(historyLooksLikeDrilldown([])).toBe(false);
  });

  it('is true when an assistant turn has a number', () => {
    expect(historyLooksLikeDrilldown([{ role: 'assistant', content: 'Tenés 3 citas.' }])).toBe(
      true,
    );
  });

  it('is true when an assistant turn uses "tenés"/"hay"', () => {
    expect(historyLooksLikeDrilldown([{ role: 'assistant', content: 'tenés citas.' }])).toBe(true);
    expect(historyLooksLikeDrilldown([{ role: 'assistant', content: 'hay disponibilidad' }])).toBe(
      true,
    );
  });

  it('is false when only the user turn has the quantitative marker', () => {
    expect(historyLooksLikeDrilldown([{ role: 'user', content: 'tengo 3 turnos?' }])).toBe(false);
  });

  it('is false for a plain assistant message without quantity', () => {
    expect(historyLooksLikeDrilldown([{ role: 'assistant', content: 'Listo, agendado.' }])).toBe(
      false,
    );
  });
});
