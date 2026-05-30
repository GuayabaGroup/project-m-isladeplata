import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import type { ButtonShortcut } from '../../../../../src/graph/supervisor/buttonShortcut.js';
import { sendClientSummary } from '../../../../../src/graph/tools/system/sendClientSummary.js';
import type { LlmProvider } from '../../../../../src/infrastructure/llm/LlmProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const mockLlm = { complete: vi.fn() } as unknown as LlmProvider;

const APT_UUID = '6e956f67-6c89-4159-957b-10b61a03400d';
const WAMID = 'wamid.HBgNNTQ5MTEzNDQ5ODA4MRUCABEYEkRERkU4N0E3RDdCN0EzRjk1NgA=';

const STAFF_IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-xyz',
  profileType: 'staff',
  roleId: 1,
  platformId: 2,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

/**
 * State con un tap de botón de template "Resumen del cliente". `shortcutValue`
 * simula lo que dejó `supervisorEntryNode`: el uuid ya resuelto (caso normal) o
 * el título estático (cuando el contextMessageId no matcheó recentTemplates).
 */
function makeState(opts: {
  profileType?: Identity['profileType'];
  shortcutValue?: string;
  contextMessageId?: string;
}): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.tap',
    contentType: 'template_button',
    contentText: 'Resumen del cliente',
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'staff' },
    interactivePayload: { type: 'button', id: 'Resumen del cliente', title: 'Resumen del cliente' },
    templateButton: { contextMessageId: opts.contextMessageId, payload: 'Resumen del cliente' },
  };
  const buttonShortcut: ButtonShortcut | undefined =
    opts.shortcutValue !== undefined
      ? { kind: 'client_summary', value: opts.shortcutValue }
      : undefined;
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: { ...STAFF_IDENTITY, profileType: opts.profileType ?? 'staff' },
    crmContext: EMPTY_CRM_CONTEXT,
    routing: { buttonShortcut },
    subgraphState: null,
    outcome: null,
  };
}

function makeGuacuco(impl: GuacucoClient['sendClientSummary']): GuacucoClient {
  return { sendClientSummary: impl } as unknown as GuacucoClient;
}

const deps = (guacuco: GuacucoClient) => ({ guacuco, logger: mockLogger, llm: mockLlm });

afterEach(() => vi.clearAllMocks());

describe('sendClientSummary tool', () => {
  it('declares staff-only', () => {
    expect(sendClientSummary.allowedRoles).toEqual(['staff']);
  });

  it('usa el uuid resuelto del shortcut y devuelve el message del backend', async () => {
    const fn = vi.fn(async () => ({
      response_type: 'text' as const,
      message: '👤 Nombre: Juan\n📞 Teléfono: ...',
      appointment_uuid: APT_UUID,
    }));
    const update = await sendClientSummary.run(
      makeState({ shortcutValue: APT_UUID, contextMessageId: WAMID }),
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(fn).toHaveBeenCalledWith(APT_UUID, expect.objectContaining({ profileType: 'staff' }));
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toContain('👤 Nombre: Juan');
  });

  it('cae al contextMessageId (wamid) cuando el shortcut no trae un uuid resuelto', async () => {
    const fn = vi.fn(async () => ({
      response_type: 'text' as const,
      message: 'resumen',
      appointment_uuid: APT_UUID,
    }));
    // shortcut.value quedó como el título estático (no se resolvió el uuid local).
    const update = await sendClientSummary.run(
      makeState({ shortcutValue: 'Resumen del cliente', contextMessageId: WAMID }),
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(fn).toHaveBeenCalledWith(WAMID, expect.anything());
    expect(update.outcome?.action).toBe('response');
  });

  it('responde sin permiso para un client (gate isToolAllowed)', async () => {
    const fn = vi.fn();
    const update = await sendClientSummary.run(
      makeState({ profileType: 'client', shortcutValue: APT_UUID, contextMessageId: WAMID }),
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(fn).not.toHaveBeenCalled();
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toMatch(/permiso/i);
  });

  it('responde amable cuando no hay referencia de cita resoluble', async () => {
    const fn = vi.fn();
    const update = await sendClientSummary.run(
      makeState({ shortcutValue: 'Resumen del cliente' }), // sin uuid ni contextMessageId
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(fn).not.toHaveBeenCalled();
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toMatch(/notificación|recordatorio/i);
  });

  it('devuelve error ante fallo del backend', async () => {
    const fn = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await sendClientSummary.run(
      makeState({ shortcutValue: APT_UUID, contextMessageId: WAMID }),
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(update.outcome?.action).toBe('error');
  });

  it('devuelve error si el backend manda message vacío', async () => {
    const fn = vi.fn(async () => ({
      response_type: 'text' as const,
      message: '   ',
      appointment_uuid: APT_UUID,
    }));
    const update = await sendClientSummary.run(
      makeState({ shortcutValue: APT_UUID, contextMessageId: WAMID }),
      deps(makeGuacuco(fn as unknown as GuacucoClient['sendClientSummary'])),
    );
    expect(update.outcome?.action).toBe('error');
  });
});
