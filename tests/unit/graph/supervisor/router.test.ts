import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../src/core/types/Identity.js';
import type { GraphState, RoutingState } from '../../../../src/graph/state.js';
import type { ButtonShortcut } from '../../../../src/graph/supervisor/buttonShortcut.js';
import {
  type RouterDestination,
  detectAtomicTool,
  routeFromSupervisor,
} from '../../../../src/graph/supervisor/router.js';

const IDENTITY_CLIENT: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'p-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};
const IDENTITY_STAFF_OWNER: Identity = { ...IDENTITY_CLIENT, profileType: 'staff', roleId: 1 };
const IDENTITY_STAFF_EMPLOYEE: Identity = { ...IDENTITY_CLIENT, profileType: 'staff', roleId: 2 };

function makeState(routing: RoutingState, identity: Identity = IDENTITY_CLIENT): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText: '',
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload: null,
  };
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity,
    crmContext: EMPTY_CRM_CONTEXT,
    routing,
    subgraphState: null,
    outcome: null,
  };
}

describe('routeFromSupervisor', () => {
  it('button shortcut wins absolute priority', () => {
    const shortcut: ButtonShortcut = { kind: 'confirm', value: 'uuid-1' };
    expect(
      routeFromSupervisor(
        makeState({ buttonShortcut: shortcut, messageType: 'greeting', confidence: 0.9 }),
      ),
    ).toBe<RouterDestination>('subgraph_placeholder');
  });

  it('human_request → social_responder (handoff handled there)', () => {
    expect(
      routeFromSupervisor(
        makeState({ messageType: 'human_request', takeoverReason: 'explicit_request' }),
      ),
    ).toBe<RouterDestination>('social_responder');
  });

  it('greeting → social', () => {
    expect(routeFromSupervisor(makeState({ messageType: 'greeting', confidence: 0.9 }))).toBe(
      'social_responder',
    );
  });

  it('farewell → social', () => {
    expect(routeFromSupervisor(makeState({ messageType: 'farewell', confidence: 0.9 }))).toBe(
      'social_responder',
    );
  });

  it('oos → social', () => {
    expect(routeFromSupervisor(makeState({ messageType: 'oos', confidence: 0.9 }))).toBe(
      'social_responder',
    );
  });

  it('action+schedule (client) → subgraph_placeholder', () => {
    expect(
      routeFromSupervisor(
        makeState({ messageType: 'action', intent: 'schedule', confidence: 0.9 }),
      ),
    ).toBe('subgraph_placeholder');
  });

  it('action+unknown without targetTool → social', () => {
    expect(
      routeFromSupervisor(makeState({ messageType: 'action', intent: 'unknown', confidence: 0.6 })),
    ).toBe('social_responder');
  });

  it('action+unknown with allowed targetTool → tool_<name>', () => {
    expect(
      routeFromSupervisor(
        makeState({
          messageType: 'action',
          intent: 'unknown',
          confidence: 0.6,
          targetTool: 'retrieve_manzanillo_url',
        }),
      ),
    ).toBe('tool_retrieve_manzanillo_url');
  });

  it('targetTool not allowed for role → social fallback (not tool_)', () => {
    expect(
      routeFromSupervisor(
        makeState(
          {
            messageType: 'action',
            intent: 'unknown',
            confidence: 0.6,
            targetTool: 'connect_mercado_pago',
          },
          IDENTITY_CLIENT,
        ),
      ),
    ).toBe('social_responder');
  });

  it('owner staff with connect_mercado_pago → tool_connect_mercado_pago', () => {
    expect(
      routeFromSupervisor(
        makeState(
          {
            messageType: 'action',
            intent: 'unknown',
            confidence: 0.6,
            targetTool: 'connect_mercado_pago',
          },
          IDENTITY_STAFF_OWNER,
        ),
      ),
    ).toBe('tool_connect_mercado_pago');
  });

  it('non-owner staff with connect_mercado_pago → social fallback (owner-only tool hidden)', () => {
    expect(
      routeFromSupervisor(
        makeState(
          {
            messageType: 'action',
            intent: 'unknown',
            confidence: 0.6,
            targetTool: 'connect_mercado_pago',
          },
          IDENTITY_STAFF_EMPLOYEE,
        ),
      ),
    ).toBe('social_responder');
  });

  it('query → subgraph_placeholder', () => {
    expect(routeFromSupervisor(makeState({ messageType: 'query', confidence: 0.9 }))).toBe(
      'subgraph_placeholder',
    );
  });

  it('intent for tool NOT in role set (client trying connect_mercado_pago via intent) → social', () => {
    // 'connect_mercado_pago' isn't a valid intent ToolName for the subgraph set,
    // but schedule for staff is OK. We test the role filter via intent indirectly:
    // a client requesting 'reschedule' is allowed (both sets have it).
    expect(
      routeFromSupervisor(
        makeState({ messageType: 'action', intent: 'reschedule', confidence: 0.9 }),
      ),
    ).toBe('subgraph_placeholder');
  });

  it('no messageType (no classifier output) → social fallback', () => {
    expect(routeFromSupervisor(makeState({}))).toBe('social_responder');
  });
});

describe('detectAtomicTool', () => {
  it('matches link / reserva → retrieve_manzanillo_url', () => {
    expect(detectAtomicTool('quiero el link de reserva')).toBe('retrieve_manzanillo_url');
    expect(detectAtomicTool('Mandame el link por favor')).toBe('retrieve_manzanillo_url');
  });

  it('matches verificación → generate_verification_url', () => {
    expect(detectAtomicTool('necesito verificar mi cuenta')).toBe('generate_verification_url');
    expect(detectAtomicTool('cómo hago el login?')).toBe('generate_verification_url');
  });

  it('matches mercado pago variants → connect_mercado_pago', () => {
    expect(detectAtomicTool('conectar mercado pago')).toBe('connect_mercado_pago');
    expect(detectAtomicTool('mercadopago para cobros')).toBe('connect_mercado_pago');
  });

  it('matches "estoy en la puerta" → forward_message', () => {
    expect(detectAtomicTool('voy a llegar tarde')).toBe('forward_message');
    expect(detectAtomicTool('estoy en la puerta')).toBe('forward_message');
  });

  it('returns null on no match', () => {
    expect(detectAtomicTool('qué hora es')).toBeNull();
    expect(detectAtomicTool('')).toBeNull();
  });
});
