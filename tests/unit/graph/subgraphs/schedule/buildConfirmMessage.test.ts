import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { CatalogState } from '../../../../../src/core/types/Catalog.js';
import {
  formatDateForUser,
  makeBuildConfirmMessageNode,
} from '../../../../../src/graph/subgraphs/schedule/nodes/buildConfirmMessage.js';
import {
  type AppointmentDraftState,
  initialAppointmentDraftState,
} from '../../../../../src/graph/subgraphs/schedule/state.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStub(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text, citations: null }] as Anthropic.Messages.ContentBlock[],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Messages.Usage,
    container: null,
  } as Anthropic.Messages.Message;
}

function makeProvider(reply: string): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => makeStub(reply));
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { llm, create };
}

const CATALOG: CatalogState = {
  services: [
    {
      uuid: 'svc-corte',
      name: 'Corte',
      description: null,
      price: 5000,
      staff: [{ uuid: 'stf-maria', name: 'María García' }],
    },
    {
      uuid: 'svc-barba',
      name: 'Barba',
      description: null,
      price: 3000,
      staff: [{ uuid: 'stf-maria', name: 'María García' }],
    },
  ],
};

function makeReadyDraft(): AppointmentDraftState {
  const d = initialAppointmentDraftState('client');
  d.slots.services = { value: ['svc-corte'], displayName: 'Corte', status: 'resolved' };
  d.slots.staff = { value: 'stf-maria', displayName: 'María García', status: 'resolved' };
  d.slots.date = { value: '2026-05-28', status: 'resolved' };
  d.slots.time = { value: '16:00', status: 'resolved' };
  d.phase = 'awaiting_confirmation';
  return d;
}

afterEach(() => vi.clearAllMocks());

describe('formatDateForUser', () => {
  it('formats date as "weekday DD de month" in Spanish', () => {
    expect(formatDateForUser('2026-05-28')).toBe('jueves 28 de mayo');
    expect(formatDateForUser('2026-12-01')).toBe('martes 1 de diciembre');
  });

  it('returns input unchanged when malformed', () => {
    expect(formatDateForUser('not-a-date')).toBe('not-a-date');
  });
});

describe('buildConfirmMessage', () => {
  it('generates message + intentUuid happy path (single service)', async () => {
    const { llm, create } = makeProvider(
      '¡Listo! Voy a agendar tu Corte con María García el jueves 28 de mayo a las 16:00. ¿Confirmás?',
    );
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    const update = await node({ catalog: CATALOG, subgraphState: makeReadyDraft() });

    expect(update.confirmation?.message).toContain('Corte');
    expect(update.confirmation?.intentUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(update.confirmation?.requestedAt).toBeDefined();
    expect(update.phase).toBe('awaiting_confirmation');
    expect(create).toHaveBeenCalledOnce();
  });

  it('passes display names (NOT uuids) in the user prompt', async () => {
    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ catalog: CATALOG, subgraphState: makeReadyDraft() });

    const params = create.mock.calls[0]?.[0];
    const userMsg = params?.messages?.[0]?.content as string;
    expect(userMsg).toContain('Corte');
    expect(userMsg).toContain('María García');
    expect(userMsg).not.toContain('svc-corte');
    expect(userMsg).not.toContain('stf-maria');
  });

  it('renders date in legible Spanish format', async () => {
    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ catalog: CATALOG, subgraphState: makeReadyDraft() });

    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).toContain('jueves 28 de mayo');
    expect(userMsg).toContain('16:00');
  });

  it('includes price when services have it in catalog (sum)', async () => {
    const draft = makeReadyDraft();
    draft.slots.services = {
      value: ['svc-corte', 'svc-barba'],
      displayName: 'Corte + Barba',
      status: 'resolved',
    };
    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ catalog: CATALOG, subgraphState: draft });

    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).toMatch(/\$8\.000|\$8000/); // 5000 + 3000
  });

  it('omits price line when catalog has no price', async () => {
    const noPriceCatalog: CatalogState = {
      services: [
        {
          uuid: 'svc-x',
          name: 'X',
          description: null,
          price: null,
          staff: [{ uuid: 'stf-1', name: 'St' }],
        },
      ],
    };
    const draft = makeReadyDraft();
    draft.slots.services = { value: ['svc-x'], displayName: 'X', status: 'resolved' };
    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ catalog: noPriceCatalog, subgraphState: draft });

    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).not.toContain('Precio');
  });

  it('is idempotent: if confirmation already set, skips LLM', async () => {
    const draft = makeReadyDraft();
    draft.confirmation = {
      intentUuid: 'existing-uuid',
      message: 'cached message',
      requestedAt: '2026-05-27T12:00:00Z',
    };
    const { llm, create } = makeProvider('new message');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });

    const update = await node({ catalog: CATALOG, subgraphState: draft });
    expect(create).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });

  it('returns no-op when slots not resolved', async () => {
    const draft = initialAppointmentDraftState('client');
    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });

    const update = await node({ catalog: CATALOG, subgraphState: draft });
    expect(create).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });

  it('falls back to deterministic template when LLM returns empty', async () => {
    const { llm } = makeProvider('');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    const update = await node({ catalog: CATALOG, subgraphState: makeReadyDraft() });
    expect(update.confirmation?.message).toContain('Corte');
    expect(update.confirmation?.message).toContain('María García');
    expect(update.confirmation?.message).toContain('jueves 28 de mayo');
  });

  it('staff role: includes client name (from clientUuid userPhrase) in prompt', async () => {
    const draft = initialAppointmentDraftState('staff');
    draft.slots.services = { value: ['svc-corte'], displayName: 'Corte', status: 'resolved' };
    draft.slots.staff = { value: 'stf-maria', displayName: 'María García', status: 'resolved' };
    draft.slots.date = { value: '2026-05-28', status: 'resolved' };
    draft.slots.time = { value: '16:00', status: 'resolved' };
    draft.slots.clientUuid = { userPhrase: 'Ana Lopez 1144556677', status: 'guessed' };

    const { llm, create } = makeProvider('ok');
    const node = makeBuildConfirmMessageNode({ llm, logger: mockLogger });
    await node({ catalog: CATALOG, subgraphState: draft });

    const userMsg = (create.mock.calls[0]?.[0]?.messages?.[0]?.content as string) ?? '';
    expect(userMsg).toContain('Ana Lopez');
  });
});
