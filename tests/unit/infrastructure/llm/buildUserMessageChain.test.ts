import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { buildUserMessageChain } from '../../../../src/infrastructure/llm/buildUserMessageChain.js';

describe('buildUserMessageChain', () => {
  it('returns only current text when history is empty', () => {
    const out = buildUserMessageChain([], 'hola');
    expect(out).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('returns empty array when history is empty and currentText is empty', () => {
    const out = buildUserMessageChain([], '');
    expect(out).toEqual([]);
  });

  it('maps Human → user and AI → assistant', () => {
    const history = [new HumanMessage('hola'), new AIMessage('hey, en qué te ayudo?')];
    const out = buildUserMessageChain(history, 'quiero un turno');
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hey, en qué te ayudo?' },
      { role: 'user', content: 'quiero un turno' },
    ]);
  });

  it('skips system messages (those go in `system` field of SDK)', () => {
    const history = [
      new SystemMessage('sos un agente'),
      new HumanMessage('hola'),
      new AIMessage('hey'),
    ];
    const out = buildUserMessageChain(history, 'cancelar');
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'cancelar' },
    ]);
  });

  it('skips messages with empty content', () => {
    const history = [new HumanMessage(''), new AIMessage('respuesta')];
    const out = buildUserMessageChain(history, 'hi');
    expect(out).toEqual([
      { role: 'assistant', content: 'respuesta' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('handles complex content (array of content parts) by joining text parts', () => {
    const msg = new AIMessage({
      content: [
        { type: 'text', text: 'Parte 1.' },
        { type: 'text', text: ' Parte 2.' },
      ],
    });
    const out = buildUserMessageChain([msg], 'siguiente');
    expect(out).toEqual([
      { role: 'assistant', content: 'Parte 1. Parte 2.' },
      { role: 'user', content: 'siguiente' },
    ]);
  });

  it('does not append currentText when it is empty (e.g. resume flow)', () => {
    const history = [new HumanMessage('hola')];
    const out = buildUserMessageChain(history, '');
    expect(out).toEqual([{ role: 'user', content: 'hola' }]);
  });
});
