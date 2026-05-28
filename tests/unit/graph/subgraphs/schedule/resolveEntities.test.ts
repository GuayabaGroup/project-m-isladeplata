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

// resolveEntities sólo llama a Guacuco para resolver el cliente (rol staff). En
// los tests de services/staff nunca debería invocarse; lo mockeamos por si acaso.
const mockGuacuco = {
  resolveClient: vi.fn(),
} as unknown as Parameters<typeof makeResolveEntitiesNode>[0]['guacuco'];

const deps = { guacuco: mockGuacuco, logger: mockLogger };

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
  it('resolves single service by exact name', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

  it('resolves multi-service split by "y"', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

  it('keeps status guessed when one part does not match', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte y pedicura', status: 'guessed' },
      }),
    });
    expect(update.slots?.services.status).toBe('guessed');
  });

  it('matches by substring (case + accents insensitive)', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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
  it('resolves staff by first name', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

  it('handles accent-stripped names', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        staff: { userPhrase: 'maria', status: 'guessed' },
      }),
    });
    expect(update.slots?.staff.value).toBe('stf-maria');
  });

  it('keeps status guessed when staff not found', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

describe('resolveEntities — empty catalog guard', () => {
  const IDENTITY_STAFF: Identity = { ...IDENTITY_CLIENT, profileType: 'staff' };

  it('terminates with actionable staff message when catalog has no services', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: { services: [] },
      identity: IDENTITY_STAFF,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte de cabello', status: 'guessed' },
      }),
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toContain('personal asignado');
    // No re-pregunta: no devuelve slots para volver a ask_slot.
    expect(update.slots).toBeUndefined();
  });

  it('terminates with client-facing message when catalog is empty for a client', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: { services: [] },
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte', status: 'guessed' },
      }),
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.pendingReply?.text).toContain('no hay servicios disponibles');
  });

  it('does NOT short-circuit when services already resolved (edge: stale empty catalog)', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: { services: [] },
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { value: ['svc-x'], displayName: 'X', status: 'resolved' },
      }),
    });
    expect(update.phase).not.toBe('failed');
    expect(update.terminalOutcome).toBeUndefined();
  });
});

describe('resolveEntities — staff inference', () => {
  it('infers staff when single service has only 1 staff', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

  it('does NOT infer when service has multiple staff', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte', status: 'guessed' },
        staff: { status: 'empty' },
      }),
    });
    expect(update.slots?.staff.status).toBe('empty');
  });

  it('does NOT infer when there are multiple services', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({
        services: { userPhrase: 'corte y barba', status: 'guessed' },
        staff: { status: 'empty' },
      }),
    });
    expect(update.slots?.staff.status).toBe('empty');
  });

  it('does NOT overwrite a staff explicitly resolved by user', async () => {
    const node = makeResolveEntitiesNode(deps);
    const update = await node({
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

describe('resolveEntities — client (rol staff, find-or-create por teléfono)', () => {
  const IDENTITY_STAFF: Identity = { ...IDENTITY_CLIENT, profileType: 'staff' };

  function makeStaffDraftWithClientPhrase(phrase: string): AppointmentDraftState {
    const base = initialAppointmentDraftState('staff');
    base.slots.clientUuid = { userPhrase: phrase, status: 'guessed' };
    return base;
  }

  it('resolves clientUuid via Guacuco when a phone is present', async () => {
    const resolveClient = vi.fn().mockResolvedValue({ client_uuid: 'cli-123', name: 'Juan' });
    const guacuco = { resolveClient } as unknown as typeof mockGuacuco;
    const node = makeResolveEntitiesNode({ guacuco, logger: mockLogger });

    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_STAFF,
      subgraphState: makeStaffDraftWithClientPhrase('juan +5491134498081'),
    });

    expect(resolveClient).toHaveBeenCalledWith(
      {
        business_allia_id: 'allia-1',
        client_phone: '+5491134498081',
        client_name: 'juan',
      },
      IDENTITY_STAFF,
    );
    expect(update.slots?.clientUuid).toEqual({
      value: 'cli-123',
      displayName: 'Juan',
      userPhrase: 'juan +5491134498081',
      status: 'resolved',
    });
  });

  it('keeps clientUuid guessed (no Guacuco call) when no phone is present', async () => {
    const resolveClient = vi.fn();
    const guacuco = { resolveClient } as unknown as typeof mockGuacuco;
    const node = makeResolveEntitiesNode({ guacuco, logger: mockLogger });

    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_STAFF,
      subgraphState: makeStaffDraftWithClientPhrase('Juan Perez'),
    });

    expect(resolveClient).not.toHaveBeenCalled();
    expect(update.slots?.clientUuid?.status).toBe('guessed');
    expect(update.slots?.clientUuid?.value).toBeUndefined();
  });

  it('keeps clientUuid guessed when Guacuco fails (no spin)', async () => {
    const resolveClient = vi.fn().mockRejectedValue(new Error('Guacuco down'));
    const guacuco = { resolveClient } as unknown as typeof mockGuacuco;
    const node = makeResolveEntitiesNode({ guacuco, logger: mockLogger });

    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_STAFF,
      subgraphState: makeStaffDraftWithClientPhrase('juan +5491134498081'),
    });

    expect(resolveClient).toHaveBeenCalled();
    expect(update.slots?.clientUuid?.status).toBe('guessed');
    expect(update.slots?.clientUuid?.value).toBeUndefined();
  });

  it('does NOT resolve client for client role (no clientUuid slot)', async () => {
    const resolveClient = vi.fn();
    const guacuco = { resolveClient } as unknown as typeof mockGuacuco;
    const node = makeResolveEntitiesNode({ guacuco, logger: mockLogger });

    const update = await node({
      catalog: CATALOG,
      identity: IDENTITY_CLIENT,
      subgraphState: makeDraft({ services: { userPhrase: 'corte', status: 'guessed' } }),
    });

    expect(resolveClient).not.toHaveBeenCalled();
    expect(update.slots?.clientUuid).toBeUndefined();
  });
});
