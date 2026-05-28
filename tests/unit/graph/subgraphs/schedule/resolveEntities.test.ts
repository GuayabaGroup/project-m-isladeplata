import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CatalogState } from '../../../../../src/core/types/Catalog.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeResolveEntitiesNode } from '../../../../../src/graph/subgraphs/schedule/nodes/resolveEntities.js';
import {
  type AppointmentDraftState,
  initialAppointmentDraftState,
} from '../../../../../src/graph/subgraphs/schedule/state.js';

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-client',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const CATALOG: CatalogState = {
  services: [
    {
      uuid: 'svc-corte',
      name: 'Corte',
      description: null,
      price: 5000,
      staff: [
        { uuid: 'stf-maria', name: 'María García' },
        { uuid: 'stf-juan', name: 'Juan Pérez' },
      ],
    },
    {
      uuid: 'svc-barba',
      name: 'Barba',
      description: null,
      price: 3000,
      staff: [{ uuid: 'stf-juan', name: 'Juan Pérez' }],
    },
    {
      uuid: 'svc-masaje',
      name: 'Masaje',
      description: null,
      price: 8000,
      staff: [{ uuid: 'stf-laura', name: 'Laura' }],
    },
  ],
};

function makeDraft(overrides: Partial<AppointmentDraftState['slots']> = {}): AppointmentDraftState {
  const base = initialAppointmentDraftState('client');
  base.slots = { ...base.slots, ...overrides };
  return base;
}

describe('resolveEntities — services', () => {
  it('resolves single service by exact name', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte', status: 'guessed' },
      }),
    });
    expect(update.slots?.services).toEqual({
      value: ['svc-corte'],
      userPhrase: 'corte',
      displayName: 'Corte',
      status: 'resolved',
    });
  });

  it('resolves multi-service split by "y"', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte y barba', status: 'guessed' },
      }),
    });
    expect(update.slots?.services).toEqual({
      value: ['svc-corte', 'svc-barba'],
      userPhrase: 'corte y barba',
      displayName: 'Corte + Barba',
      status: 'resolved',
    });
  });

  it('keeps status guessed when one part does not match', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte y pedicura', status: 'guessed' },
      }),
    });
    expect(update.slots?.services.status).toBe('guessed');
  });

  it('matches by substring (case + accents insensitive)', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'MASAJE', status: 'guessed' },
      }),
    });
    expect(update.slots?.services.value).toEqual(['svc-masaje']);
  });
});

describe('resolveEntities — staff', () => {
  it('resolves staff by first name', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        staff: { userPhrase: 'María', status: 'guessed' },
      }),
    });
    expect(update.slots?.staff).toEqual({
      value: 'stf-maria',
      displayName: 'María García',
      userPhrase: 'María',
      status: 'resolved',
    });
  });

  it('handles accent-stripped names', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        staff: { userPhrase: 'maria', status: 'guessed' },
      }),
    });
    expect(update.slots?.staff.value).toBe('stf-maria');
  });

  it('keeps status guessed when staff not found', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        staff: { userPhrase: 'Roberto', status: 'guessed' },
      }),
    });
    expect(update.slots?.staff.status).toBe('guessed');
    expect(update.slots?.staff.value).toBeUndefined();
  });
});

describe('resolveEntities — staff inference', () => {
  it('infers staff when single service has only 1 staff', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'masaje', status: 'guessed' },
        staff: { status: 'empty' },
      }),
    });
    // resolveEntities first resolves services to svc-masaje (1 staff: Laura), then infers
    expect(update.slots?.staff).toEqual({
      value: 'stf-laura',
      displayName: 'Laura',
      status: 'resolved',
    });
  });

  it('does NOT infer when service has multiple staff', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte', status: 'guessed' },
        staff: { status: 'empty' },
      }),
    });
    expect(update.slots?.staff.status).toBe('empty');
  });

  it('does NOT infer when there are multiple services', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte y barba', status: 'guessed' },
        staff: { status: 'empty' },
      }),
    });
    expect(update.slots?.staff.status).toBe('empty');
  });

  it('does NOT overwrite a staff explicitly resolved by user', () => {
    const node = makeResolveEntitiesNode({ logger: mockLogger });
    const update = node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'masaje', status: 'guessed' },
        staff: {
          value: 'stf-juan',
          displayName: 'Juan Pérez',
          status: 'resolved',
        },
      }),
    });
    expect(update.slots?.staff.value).toBe('stf-juan');
  });
});
