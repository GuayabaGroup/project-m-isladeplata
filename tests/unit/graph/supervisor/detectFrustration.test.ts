import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { makeFrustrationJudge } from '../../../../src/graph/supervisor/detectFrustration.js';
import {
  type AnthropicMessagesLike,
  AnthropicProvider,
} from '../../../../src/infrastructure/llm/AnthropicProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeStubMessage(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: text.length
      ? ([{ type: 'text', text, citations: null }] as Anthropic.Messages.ContentBlock[])
      : ([] as Anthropic.Messages.ContentBlock[]),
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

function makeJudge(reply: string) {
  const create = vi.fn(async () => makeStubMessage(reply));
  const client: AnthropicMessagesLike = { create };
  const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
  return { judge: makeFrustrationJudge({ llm, logger: mockLogger }), create };
}

afterEach(() => vi.clearAllMocks());

describe('makeFrustrationJudge', () => {
  it('returns true on clear frustration at/above threshold', async () => {
    const { judge } = makeJudge('{"frustrated":true,"confidence":0.9}');
    expect(await judge('son un desastre, no sirve para nada')).toBe(true);
  });

  it('returns false when confidence is below threshold (anti false-positive)', async () => {
    const { judge } = makeJudge('{"frustrated":true,"confidence":0.5}');
    expect(await judge('mmm no sé')).toBe(false);
  });

  it('returns false when not frustrated', async () => {
    const { judge } = makeJudge('{"frustrated":false,"confidence":0.95}');
    expect(await judge('hola, quiero un turno')).toBe(false);
  });

  it('fail-closed: returns false when JSON does not parse', async () => {
    const { judge } = makeJudge('no soy json');
    expect(await judge('texto cualquiera')).toBe(false);
  });

  it('fail-closed: returns false (no throw) when the LLM throws', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    const client: AnthropicMessagesLike = { create };
    const llm = new AnthropicProvider({ apiKey: 'test-anthropic-key', logger: mockLogger, client });
    const judge = makeFrustrationJudge({ llm, logger: mockLogger });
    expect(await judge('cualquier cosa')).toBe(false);
  });

  it('skips the LLM call on empty input', async () => {
    const { judge, create } = makeJudge('{"frustrated":true,"confidence":1}');
    expect(await judge('')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
