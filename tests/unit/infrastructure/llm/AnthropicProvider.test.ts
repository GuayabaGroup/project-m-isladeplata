import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
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

function makeMessageResponse(
  overrides: Partial<Anthropic.Messages.Message> = {},
): Anthropic.Messages.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Messages.Usage,
    container: null,
    ...overrides,
  } as Anthropic.Messages.Message;
}

function makeProvider(mockCreate: AnthropicMessagesLike['create']): AnthropicProvider {
  const client: AnthropicMessagesLike = { create: mockCreate };
  return new AnthropicProvider({
    apiKey: 'test-anthropic-key',
    logger: mockLogger,
    client,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AnthropicProvider.complete', () => {
  it('returns concatenated text from text blocks', async () => {
    const mockCreate = vi.fn(async () =>
      makeMessageResponse({
        content: [
          { type: 'text', text: 'Hola, ', citations: null },
          { type: 'text', text: 'mundo!', citations: null },
        ] as Anthropic.Messages.ContentBlock[],
      }),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'claude-haiku-4-5-20251001',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(out.text).toBe('Hola, mundo!');
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe('end_turn');
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('extracts tool_use blocks into toolCalls', async () => {
    const mockCreate = vi.fn(async () =>
      makeMessageResponse({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'I will call a tool.', citations: null },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'classify',
            input: { messageType: 'greeting', confidence: 0.9 },
          },
        ] as Anthropic.Messages.ContentBlock[],
      }),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'hola' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out.text).toBe('I will call a tool.');
    expect(out.toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'classify',
        input: { messageType: 'greeting', confidence: 0.9 },
      },
    ]);
    expect(out.stopReason).toBe('tool_use');
  });

  it('passes tools through to the SDK when provided', async () => {
    const mockCreate = vi.fn(async () => makeMessageResponse());
    const provider = makeProvider(mockCreate);

    await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
      tools: [
        {
          name: 'classify',
          description: 'classifier',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0];
    expect(call).toBeDefined();
    const params = call?.[0];
    expect(params?.tools).toHaveLength(1);
    const firstTool = params?.tools?.[0] as { name: string } | undefined;
    expect(firstTool?.name).toBe('classify');
  });

  it('omits tools key when not provided', async () => {
    const mockCreate = vi.fn(async () => makeMessageResponse());
    const provider = makeProvider(mockCreate);

    await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });

    const params = mockCreate.mock.calls[0]?.[0];
    expect(params).toBeDefined();
    expect('tools' in (params ?? {})).toBe(false);
  });

  it('omits tools key when array is empty', async () => {
    const mockCreate = vi.fn(async () => makeMessageResponse());
    const provider = makeProvider(mockCreate);

    await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
      tools: [],
    });

    const params = mockCreate.mock.calls[0]?.[0];
    expect('tools' in (params ?? {})).toBe(false);
  });

  it('returns blank output on SDK throw (never propagates)', async () => {
    const mockCreate = vi.fn(async () => {
      throw new Error('rate_limit');
    });
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out).toEqual({
      text: '',
      toolCalls: [],
      stopReason: 'error',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('trims whitespace around concatenated text', async () => {
    const mockCreate = vi.fn(async () =>
      makeMessageResponse({
        content: [
          { type: 'text', text: '  \n  hola', citations: null },
          { type: 'text', text: ' mundo  \n', citations: null },
        ] as Anthropic.Messages.ContentBlock[],
      }),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out.text).toBe('hola mundo');
  });

  it('handles missing stop_reason gracefully', async () => {
    const mockCreate = vi.fn(async () =>
      makeMessageResponse({
        stop_reason: null,
      }),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out.stopReason).toBe('unknown');
  });
});
