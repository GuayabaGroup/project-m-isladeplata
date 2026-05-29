import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../../src/clients/GuacucoClient.js';
import type { ChannelMessage } from '../../../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import type { GraphState } from '../../../../../src/graph/state.js';
import type { ToolDeps } from '../../../../../src/graph/tools/Tool.js';
import { forwardMessage } from '../../../../../src/graph/tools/support/forwardMessage.js';
import type {
  LlmCompleteOutput,
  LlmProvider,
} from '../../../../../src/infrastructure/llm/LlmProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-abc',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeState(contentText: string): GraphState {
  const message: ChannelMessage = {
    channelType: 'whatsapp',
    channelId: '5491100',
    messageId: 'wamid.1',
    contentType: 'text',
    contentText,
    receivedAt: new Date().toISOString(),
    channelMeta: { phoneNumberId: 'pn-1', role: 'client' },
    interactivePayload: null,
  };
  return {
    messages: [],
    input: { channelMessage: message, receivedAt: message.receivedAt },
    identity: IDENTITY,
    crmContext: EMPTY_CRM_CONTEXT,
    routing: { messageType: 'action', intent: 'unknown', confidence: 0.6 },
    subgraphState: null,
    outcome: null,
  };
}

function makeGuacuco(impl: GuacucoClient['forwardMessage']): GuacucoClient {
  return { forwardMessage: impl } as unknown as GuacucoClient;
}

/** Mock LlmProvider. `text` is the summary it returns; `''` simulates failure. */
function makeLlm(text: string): LlmProvider {
  const output: LlmCompleteOutput = {
    text,
    toolCalls: [],
    stopReason: text.length > 0 ? 'end_turn' : 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  return { complete: vi.fn(async () => output) };
}

function makeDeps(
  forward: GuacucoClient['forwardMessage'],
  summary = 'El cliente avisa que llegó al local.',
): ToolDeps {
  return {
    guacuco: makeGuacuco(forward),
    logger: mockLogger,
    llm: makeLlm(summary),
  };
}

afterEach(() => vi.clearAllMocks());

describe('forwardMessage tool', () => {
  it('forwards the LLM summary (not the raw text) and confirms', async () => {
    const forward = vi.fn(async () => ({}));
    const update = await forwardMessage.run(
      makeState('Estoy en la <b>puerta</b>'),
      makeDeps(
        forward as unknown as GuacucoClient['forwardMessage'],
        'El cliente está en la puerta.',
      ),
    );
    expect(forward).toHaveBeenCalledWith('El cliente está en la puerta.', IDENTITY);
    expect(update.outcome?.action).toBe('response');
    expect(update.outcome?.pendingReply?.text).toMatch(/enviado al negocio/i);
  });

  it('falls back to the raw sanitized text when the summary is empty (fail-open)', async () => {
    const forward = vi.fn(async () => ({}));
    const update = await forwardMessage.run(
      makeState('Estoy en la <b>puerta</b>'),
      makeDeps(forward as unknown as GuacucoClient['forwardMessage'], ''),
    );
    // HTML stripped by sanitizeUserInput; summary empty → raw text forwarded.
    expect(forward).toHaveBeenCalledWith('Estoy en la puerta', IDENTITY);
    expect(update.outcome?.action).toBe('response');
  });

  it('returns ignored on empty input (nothing to forward, no LLM call)', async () => {
    const forward = vi.fn();
    const deps = makeDeps(forward as unknown as GuacucoClient['forwardMessage']);
    const update = await forwardMessage.run(makeState('   '), deps);
    expect(update.outcome?.action).toBe('ignored');
    expect(forward).not.toHaveBeenCalled();
    expect(deps.llm.complete).not.toHaveBeenCalled();
  });

  it('returns error when identity is incomplete', async () => {
    const state = makeState('mensaje');
    state.identity = { ...IDENTITY, tenantAlliaId: '' };
    const forward = vi.fn();
    const update = await forwardMessage.run(
      state,
      makeDeps(forward as unknown as GuacucoClient['forwardMessage']),
    );
    expect(update.outcome?.action).toBe('error');
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns error on backend failure', async () => {
    const forward = vi.fn(async () => {
      throw new Error('upstream');
    });
    const update = await forwardMessage.run(
      makeState('hola'),
      makeDeps(forward as unknown as GuacucoClient['forwardMessage']),
    );
    expect(update.outcome?.action).toBe('error');
  });

  it('declares both roles', () => {
    expect(forwardMessage.allowedRoles).toEqual(['client', 'staff']);
  });
});
