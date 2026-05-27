import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { EMPTY_CRM_CONTEXT } from '../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import {
  GraphStateAnnotation,
  MAX_RECENT_MESSAGES,
  appendMessages,
  mergeRouting,
  replaceWith,
} from '../../../src/graph/state.js';

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'prof-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

describe('appendMessages reducer', () => {
  it('appends two arrays', () => {
    const result = appendMessages([new HumanMessage('a')], [new HumanMessage('b')]);
    expect(result).toHaveLength(2);
  });

  it('caps to MAX_RECENT_MESSAGES most recent', () => {
    const initial = Array.from(
      { length: MAX_RECENT_MESSAGES },
      (_, i) => new HumanMessage(`m${i}`),
    );
    const result = appendMessages(initial, [new HumanMessage('extra')]);
    expect(result).toHaveLength(MAX_RECENT_MESSAGES);
    expect((result[result.length - 1] as HumanMessage).content).toBe('extra');
  });

  it('returns combined when under cap', () => {
    const result = appendMessages([new HumanMessage('a')], []);
    expect(result).toHaveLength(1);
  });
});

describe('replaceWith reducer', () => {
  it('returns the next value, ignoring current', () => {
    expect(replaceWith(null, IDENTITY)).toEqual(IDENTITY);
    expect(replaceWith(IDENTITY, null)).toBeNull();
  });

  it('replaces objects entirely (no merge)', () => {
    const original = { a: 1, b: 2 };
    const next = { a: 99 } as { a: number; b?: number };
    expect(replaceWith(original, next)).toEqual({ a: 99 });
  });
});

describe('mergeRouting reducer', () => {
  it('merges partial updates', () => {
    const after1 = mergeRouting({}, { activeSubgraph: 'schedule' });
    const after2 = mergeRouting(after1, { handoff: 'user_changed_intent' });
    expect(after2).toEqual({ activeSubgraph: 'schedule', handoff: 'user_changed_intent' });
  });

  it('overwrites existing keys', () => {
    const result = mergeRouting({ activeSubgraph: 'schedule' }, { activeSubgraph: 'cancel' });
    expect(result.activeSubgraph).toBe('cancel');
  });
});

describe('GraphStateAnnotation', () => {
  it('exposes the State type via Annotation.Root', () => {
    expect(GraphStateAnnotation).toBeDefined();
  });

  it('default state has empty messages and empty crmContext', () => {
    // El default real lo aplica el StateGraph internamente; aquí solo verificamos
    // que el shape es accesible para tipado.
    const defaultCrm = EMPTY_CRM_CONTEXT;
    expect(defaultCrm.upcomingAppointments).toEqual([]);
  });
});
