import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { CatalogState } from '../../../../../src/core/types/Catalog.js';
import type { CrmContext } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import { makeClassifyQueryNode } from '../../../../../src/graph/subgraphs/query/nodes/classifyQuery.js';
import { makeFetchIntentNode } from '../../../../../src/graph/subgraphs/query/nodes/fetchIntent.js';
import { makeSynthesizeResponseNode } from '../../../../../src/graph/subgraphs/query/nodes/synthesizeResponse.js';
import {
  type QueryDraftState,
  initialQueryDraftState,
} from '../../../../../src/graph/subgraphs/query/state.js';
import type { PlatformContentLoader } from '../../../../../src/infrastructure/content/PlatformContentLoader.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
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

const IDENTITY_STAFF: Identity = {
  ...IDENTITY_CLIENT,
  profileUuid: 'profile-staff',
  profileType: 'staff',
};

const CATALOG: CatalogState = {
  services: [
    {
      uuid: 'svc-corte',
      name: 'Corte',
      description: 'Corte de pelo',
      price: 5000,
      staff: [{ uuid: 'stf-1', name: 'María' }],
    },
    {
      uuid: 'svc-color',
      name: 'Color',
      description: null,
      price: 12000,
      staff: [{ uuid: 'stf-1', name: 'María' }],
    },
  ],
};

const CRM_TWO_UPCOMING: CrmContext = {
  upcomingAppointments: [
    { appointmentUuid: 'apt-1', description: 'Corte mañana 16:00', startAt: '2026-05-28T16:00' },
    { appointmentUuid: 'apt-2', description: 'Color viernes 10:00', startAt: '2026-06-04T10:00' },
  ],
  profileMeta: {},
};

const CRM_EMPTY: CrmContext = { upcomingAppointments: [], profileMeta: {} };

function stub(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    container: null,
  } as Anthropic.Messages.Message;
}

function makeLlm(...replies: string[]): {
  llm: AnthropicProvider;
  create: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const create = vi.fn(async () => stub(replies[i++] ?? ''));
  const client: AnthropicMessagesLike = { create };
  return {
    llm: new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client }),
    create,
  };
}

function readyDraft(intent: QueryDraftState['intent'], text = 'q'): QueryDraftState {
  const d = initialQueryDraftState(text);
  d.intent = intent;
  d.phase = 'fetching';
  return d;
}

afterEach(() => vi.clearAllMocks());

// ============================================================================
// classifyQuery
// ============================================================================

describe('query.classifyQuery — client', () => {
  it('parses JSON intent, sets phase=fetching for lookup intents', async () => {
    const { llm } = makeLlm('{"intent":"service_prices","confidence":0.9}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: initialQueryDraftState('cuánto cuesta corte'),
    });
    expect(update.intent).toBe('service_prices');
    expect(update.confidence).toBe(0.9);
    expect(update.phase).toBe('fetching');
  });

  it('rebajes staff_schedule_day a cannot_answer cuando rol=client', async () => {
    const { llm } = makeLlm('{"intent":"staff_schedule_day","confidence":0.85}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: initialQueryDraftState('qué turnos tengo mañana'),
    });
    expect(update.intent).toBe('cannot_answer');
    expect(update.phase).toBe('synthesizing');
  });

  it('fail-open a cannot_answer cuando JSON inválido', async () => {
    const { llm } = makeLlm('no es json');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: initialQueryDraftState('?'),
    });
    expect(update.intent).toBe('cannot_answer');
    expect(update.phase).toBe('synthesizing');
  });

  it('userText vacío → cannot_answer sin LLM call', async () => {
    const { llm, create } = makeLlm('should not be called');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: initialQueryDraftState(''),
    });
    expect(create).not.toHaveBeenCalled();
    expect(update.intent).toBe('cannot_answer');
  });
});

describe('query.classifyQuery — staff', () => {
  it('permite staff_schedule_day cuando rol=staff', async () => {
    const { llm } = makeLlm('{"intent":"staff_schedule_day","confidence":0.92}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('qué turnos tengo hoy'),
    });
    expect(update.intent).toBe('staff_schedule_day');
    expect(update.phase).toBe('fetching');
  });

  it('staff_schedule_day con fecha relativa: propaga scheduleRange (resumen de mañana)', async () => {
    const { llm } = makeLlm(
      '{"intent":"staff_schedule_day","confidence":0.9,"date_start":"2026-05-31","date_end":"2026-05-31"}',
    );
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('dame el resumen de mañana'),
    });
    expect(update.intent).toBe('staff_schedule_day');
    expect(update.phase).toBe('fetching');
    expect(update.scheduleRange).toEqual({ dateStart: '2026-05-31', dateEnd: '2026-05-31' });
  });

  it('staff_schedule_day sin fechas válidas: scheduleRange queda undefined (fetch cae a hoy)', async () => {
    const { llm } = makeLlm('{"intent":"staff_schedule_day","confidence":0.85,"date_start":"hoy"}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('mi agenda'),
    });
    expect(update.intent).toBe('staff_schedule_day');
    expect(update.scheduleRange).toBeUndefined();
  });

  it('descarta date_start/date_end cuando el intent NO es staff_schedule_day', async () => {
    const { llm } = makeLlm(
      '{"intent":"service_prices","confidence":0.9,"date_start":"2026-05-31","date_end":"2026-05-31"}',
    );
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('cuánto cuesta corte'),
    });
    expect(update.intent).toBe('service_prices');
    expect(update.scheduleRange).toBeUndefined();
  });

  it('permite platform_commercial cuando rol=staff (Nivel B)', async () => {
    const { llm } = makeLlm('{"intent":"platform_commercial","confidence":0.9}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('cuánto cuesta la plataforma'),
    });
    expect(update.intent).toBe('platform_commercial');
    expect(update.phase).toBe('fetching');
  });

  it('permite platform_onboarding cuando rol=staff (Nivel B)', async () => {
    const { llm } = makeLlm('{"intent":"platform_onboarding","confidence":0.88}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: initialQueryDraftState('cómo configuro mis horarios'),
    });
    expect(update.intent).toBe('platform_onboarding');
    expect(update.phase).toBe('fetching');
  });

  it('rebajes platform_commercial a cannot_answer cuando rol=client', async () => {
    const { llm } = makeLlm('{"intent":"platform_commercial","confidence":0.9}');
    const node = makeClassifyQueryNode({ llm, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: initialQueryDraftState('cuánto cuesta la plataforma'),
    });
    expect(update.intent).toBe('cannot_answer');
    expect(update.phase).toBe('synthesizing');
  });
});

// ============================================================================
// fetchIntent — los 3 lookup-only
// ============================================================================

describe('query.fetchIntent — lookup intents', () => {
  const stubGuacuco = {} as GuacucoClient;

  it('service_prices: returns catalog services with prices', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      catalog: CATALOG,
      subgraphState: readyDraft('service_prices'),
    });
    expect(update.phase).toBe('synthesizing');
    const result = update.rawResult as { services: Array<{ name: string; price: number | null }> };
    expect(result.services).toHaveLength(2);
    expect(result.services[0]).toEqual({
      name: 'Corte',
      description: 'Corte de pelo',
      price: 5000,
    });
  });

  it('service_list: same shape as service_prices (UI decide qué mostrar)', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      catalog: CATALOG,
      subgraphState: readyDraft('service_list'),
    });
    expect(update.phase).toBe('synthesizing');
    const result = update.rawResult as { services: Array<unknown> };
    expect(result.services).toHaveLength(2);
  });

  it('service_list: catalog vacío → services []', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      catalog: { services: [] },
      subgraphState: readyDraft('service_list'),
    });
    expect(update.phase).toBe('synthesizing');
    expect(update.rawResult).toEqual({ services: [] });
  });

  it('my_upcoming: returns crmContext upcomings normalized', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      crmContext: CRM_TWO_UPCOMING,
      subgraphState: readyDraft('my_upcoming'),
    });
    expect(update.phase).toBe('synthesizing');
    const result = update.rawResult as { upcomings: Array<{ description: string }> };
    expect(result.upcomings).toHaveLength(2);
    expect(result.upcomings[0]?.description).toBe('Corte mañana 16:00');
  });

  it('my_upcoming: sin crmContext → upcomings []', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      crmContext: CRM_EMPTY,
      subgraphState: readyDraft('my_upcoming'),
    });
    expect(update.rawResult).toEqual({ upcomings: [] });
  });
});

// ============================================================================
// fetchIntent — staff_schedule_day (call a Guacuco)
// ============================================================================

describe('query.fetchIntent — staff_schedule_day', () => {
  function makeGuacuco(impl: () => Promise<unknown>): {
    guacuco: GuacucoClient;
    call: ReturnType<typeof vi.fn>;
  } {
    const call = vi.fn(impl);
    return {
      guacuco: { getStaffAppointmentsSummary: call } as unknown as GuacucoClient,
      call,
    };
  }

  it('staff role: calls getStaffAppointmentsSummary con today + profile/business uuids', async () => {
    const { guacuco, call } = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'Tenés 2 turnos hoy.',
      summary: 'Hoy: 10:00 Corte (Juan), 14:00 Color (Ana)',
      total: 2,
      date_start: '2026-05-28',
      date_end: '2026-05-28',
      appointments: [],
    }));
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyDraft('staff_schedule_day'),
    });
    expect(update.phase).toBe('synthesizing');
    expect(call).toHaveBeenCalledOnce();
    const [params, identity] = call.mock.calls[0] ?? [];
    expect(params).toMatchObject({ date_start: expect.any(String) });
    expect((params as { date_start: string }).date_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(identity).toEqual(IDENTITY_STAFF);
  });

  it('usa el scheduleRange del clasificador (mañana), no hoy', async () => {
    const { guacuco, call } = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'Tenés 1 turno mañana.',
      summary: 'Mañana: 09:00 Baño',
      total: 1,
      date_start: '2026-05-31',
      date_end: '2026-05-31',
      appointments: [],
    }));
    const draft = readyDraft('staff_schedule_day');
    draft.scheduleRange = { dateStart: '2026-05-31', dateEnd: '2026-05-31' };
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    const update = await node({ identity: IDENTITY_STAFF, subgraphState: draft });
    expect(update.phase).toBe('synthesizing');
    const [params] = call.mock.calls[0] ?? [];
    expect(params).toEqual({ date_start: '2026-05-31', date_end: '2026-05-31' });
  });

  it('scheduleRange ausente → fallback a hoy/hoy (date_start === date_end)', async () => {
    const { guacuco, call } = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'ok',
      summary: 's',
      total: 0,
      date_start: 'x',
      date_end: 'x',
      appointments: [],
    }));
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    await node({ identity: IDENTITY_STAFF, subgraphState: readyDraft('staff_schedule_day') });
    const [params] = call.mock.calls[0] ?? [];
    const p = params as { date_start: string; date_end: string };
    expect(p.date_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.date_start).toBe(p.date_end);
  });

  it('clampea el rango a 31 días cuando el clasificador pide un span mayor', async () => {
    const { guacuco, call } = makeGuacuco(async () => ({
      response_type: 'text',
      message: 'ok',
      summary: 's',
      total: 0,
      date_start: 'x',
      date_end: 'x',
      appointments: [],
    }));
    const draft = readyDraft('staff_schedule_day');
    // 90 días de span → debe recortarse a 31 (start + 30 días).
    draft.scheduleRange = { dateStart: '2026-05-01', dateEnd: '2026-07-30' };
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    await node({ identity: IDENTITY_STAFF, subgraphState: draft });
    const [params] = call.mock.calls[0] ?? [];
    expect(params).toEqual({ date_start: '2026-05-01', date_end: '2026-05-31' });
  });

  it('client role: rejects with FORBIDDEN outcome, no Guacuco call', async () => {
    const { guacuco, call } = makeGuacuco(async () => {
      throw new Error('should not be called');
    });
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: readyDraft('staff_schedule_day'),
    });
    expect(call).not.toHaveBeenCalled();
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no tengo acceso|otra cosa/i);
  });

  it('Guacuco throw → error terminal', async () => {
    const { guacuco } = makeGuacuco(async () => {
      throw new Error('upstream 500');
    });
    const node = makeFetchIntentNode({ guacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyDraft('staff_schedule_day'),
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('error');
  });
});

// ============================================================================
// fetchIntent — platform_commercial / platform_onboarding (Nivel B, H9.2)
// ============================================================================

describe('query.fetchIntent — platform content', () => {
  const stubGuacuco = {} as GuacucoClient;

  function loaderWith(map: Record<string, string>): PlatformContentLoader {
    return {
      get: (kind: string, platformId: number) => map[`${kind}:${platformId}`],
    } as unknown as PlatformContentLoader;
  }

  it('staff + contenido cargado → rawResult {kind, content}, synthesizing', async () => {
    const loader = loaderWith({ 'commercial:1': '# Allia\nPlan Pro: $10/mes.' });
    const node = makeFetchIntentNode({
      guacuco: stubGuacuco,
      logger: mockLogger,
      platformContent: loader,
    });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyDraft('platform_commercial'),
    });
    expect(update.phase).toBe('synthesizing');
    expect(update.rawResult).toEqual({
      kind: 'commercial',
      content: '# Allia\nPlan Pro: $10/mes.',
    });
  });

  it('staff + SIN contenido → handed_off + takeover (escalación determinista)', async () => {
    const node = makeFetchIntentNode({
      guacuco: stubGuacuco,
      logger: mockLogger,
      platformContent: loaderWith({}),
    });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyDraft('platform_onboarding'),
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
    expect(update.terminalOutcome?.takeover?.reasonCode).toBe('other');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/soporte/i);
  });

  it('staff + loader ausente (undefined) → escala (default seguro)', async () => {
    const node = makeFetchIntentNode({ guacuco: stubGuacuco, logger: mockLogger });
    const update = await node({
      identity: IDENTITY_STAFF,
      subgraphState: readyDraft('platform_commercial'),
    });
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('handed_off');
  });

  it('client pidiendo platform content → FORBIDDEN, sin leer loader', async () => {
    const get = vi.fn();
    const node = makeFetchIntentNode({
      guacuco: stubGuacuco,
      logger: mockLogger,
      platformContent: { get } as unknown as PlatformContentLoader,
    });
    const update = await node({
      identity: IDENTITY_CLIENT,
      subgraphState: readyDraft('platform_commercial'),
    });
    expect(get).not.toHaveBeenCalled();
    expect(update.phase).toBe('failed');
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no tengo acceso|otra cosa/i);
  });
});

// ============================================================================
// synthesizeResponse
// ============================================================================

describe('query.synthesizeResponse', () => {
  it('intent=cannot_answer: produces amable response (no rawResult needed)', async () => {
    const { llm, create } = makeLlm('No puedo responder eso. Probá con otra cosa.');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('cómo está el clima'),
      intent: 'cannot_answer',
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    expect(create).toHaveBeenCalledOnce();
    expect(update.phase).toBe('done');
    expect(update.terminalOutcome?.action).toBe('response');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/no puedo|otra cosa/i);
  });

  it('intent=service_prices: passes rawResult JSON to LLM', async () => {
    const { llm, create } = makeLlm('Corte cuesta $5000 y Color $12000.');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('precios'),
      intent: 'service_prices',
      rawResult: {
        services: [
          { name: 'Corte', price: 5000 },
          { name: 'Color', price: 12000 },
        ],
      },
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    expect(update.phase).toBe('done');
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/5000|12000/);
    const call = create.mock.calls[0]?.[0] as {
      messages?: Array<{ content: string }>;
    };
    // El LLM recibió el JSON crudo en el prompt
    expect(call?.messages?.[0]?.content).toContain('Corte');
    expect(call?.messages?.[0]?.content).toContain('5000');
  });

  it('falls back to determinístico cuando LLM devuelve vacío', async () => {
    const { llm } = makeLlm('');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('precios'),
      intent: 'service_prices',
      rawResult: { services: [] },
      phase: 'synthesizing',
    };
    const update = await node({ subgraphState: draft });
    expect(update.terminalOutcome?.pendingReply?.text).toMatch(/servicios/i);
  });

  it('intent=platform_commercial: pasa el content oficial al LLM', async () => {
    const { llm, create } = makeLlm('El plan Pro cuesta $10 por mes.');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const draft: QueryDraftState = {
      ...initialQueryDraftState('cuánto cuesta'),
      intent: 'platform_commercial',
      rawResult: { kind: 'commercial', content: '# Allia\nPlan Pro: $10/mes.' },
      phase: 'synthesizing',
    };
    const update = await node({ identity: IDENTITY_STAFF, subgraphState: draft });
    expect(update.phase).toBe('done');
    expect(update.terminalOutcome?.action).toBe('response');
    const call = create.mock.calls[0]?.[0] as {
      system?: string;
      messages?: Array<{ content: string }>;
    };
    expect(call?.messages?.[0]?.content).toContain('Plan Pro');
    // Usó la task anti-alucinación de plataforma, no la genérica.
    expect(call?.system).toMatch(/NO inventes/i);
  });

  it('cap raw_result a 2000 chars en el prompt', async () => {
    const { llm, create } = makeLlm('respuesta corta');
    const node = makeSynthesizeResponseNode({ llm, logger: mockLogger });
    const huge = { items: Array.from({ length: 200 }, (_, i) => ({ name: `item-${i}` })) };
    const draft: QueryDraftState = {
      ...initialQueryDraftState('lista'),
      intent: 'service_list',
      rawResult: huge,
      phase: 'synthesizing',
    };
    await node({ subgraphState: draft });
    const call = create.mock.calls[0]?.[0] as { messages?: Array<{ content: string }> };
    const content = call?.messages?.[0]?.content ?? '';
    // El cap es 2000 chars del rawJson, no del prompt total. El prompt total
    // tiene preamble extra (pregunta + headers). Aceptamos < 3500 como guard.
    expect(content.length).toBeLessThan(3500);
  });
});
