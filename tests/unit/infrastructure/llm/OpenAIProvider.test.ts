import type OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import {
  type OpenAIChatCompletionsLike,
  OpenAIProvider,
} from '../../../../src/infrastructure/llm/OpenAIProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeCompletion(
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletion> = {},
  choiceOverrides: Partial<OpenAI.Chat.Completions.ChatCompletion.Choice> = {},
  messageOverrides: Partial<OpenAI.Chat.Completions.ChatCompletionMessage> = {},
): OpenAI.Chat.Completions.ChatCompletion {
  const message = {
    role: 'assistant',
    content: null,
    refusal: null,
    ...messageOverrides,
  } as OpenAI.Chat.Completions.ChatCompletionMessage;
  const choice = {
    index: 0,
    message,
    finish_reason: 'stop',
    logprobs: null,
    ...choiceOverrides,
  } as OpenAI.Chat.Completions.ChatCompletion.Choice;
  return {
    id: 'cmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [choice],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    } as OpenAI.Completions.CompletionUsage,
    ...overrides,
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function makeProvider(mockCreate: OpenAIChatCompletionsLike['create']): OpenAIProvider {
  const client: OpenAIChatCompletionsLike = { create: mockCreate };
  return new OpenAIProvider({
    apiKey: 'test-openai-key',
    logger: mockLogger,
    client,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('OpenAIProvider.complete', () => {
  it('returns text content from assistant message', async () => {
    const mockCreate = vi.fn(async () => makeCompletion({}, {}, { content: '  Hola, mundo!  ' }));
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'gpt-4o-mini',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(out.text).toBe('Hola, mundo!');
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe('stop');
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(mockCreate).toHaveBeenCalledOnce();
    const params = mockCreate.mock.calls[0]?.[0];
    expect(params?.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(params?.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('extracts function tool_calls and parses arguments JSON', async () => {
    const toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall = {
      id: 'call_1',
      type: 'function',
      function: {
        name: 'classify',
        arguments: '{"messageType":"greeting","confidence":0.9}',
      },
    } as OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

    const mockCreate = vi.fn(async () =>
      makeCompletion(
        {},
        { finish_reason: 'tool_calls' },
        { content: 'I will call a tool.', tool_calls: [toolCall] },
      ),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'gpt-4o-mini',
      system: 's',
      messages: [{ role: 'user', content: 'hola' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out.text).toBe('I will call a tool.');
    expect(out.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'classify',
        input: { messageType: 'greeting', confidence: 0.9 },
      },
    ]);
    expect(out.stopReason).toBe('tool_calls');
  });

  it('falls back to empty input when tool arguments JSON is invalid', async () => {
    const toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall = {
      id: 'call_2',
      type: 'function',
      function: { name: 't', arguments: '{not json' },
    } as OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

    const mockCreate = vi.fn(async () =>
      makeCompletion({}, {}, { content: '', tool_calls: [toolCall] }),
    );
    const provider = makeProvider(mockCreate);

    const out = await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });

    expect(out.toolCalls).toEqual([{ id: 'call_2', name: 't', input: {} }]);
  });

  it('maps LlmToolSpec to OpenAI function tool shape', async () => {
    const mockCreate = vi.fn(async () => makeCompletion());
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
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });

    const params = mockCreate.mock.calls[0]?.[0];
    expect(params?.tools).toHaveLength(1);
    const first = params?.tools?.[0];
    expect(first?.type).toBe('function');
    expect(first?.function.name).toBe('classify');
    expect(first?.function.description).toBe('classifier');
    expect(first?.function.parameters).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
    });
  });

  it('omits tools key when not provided or empty', async () => {
    const mockCreate = vi.fn(async () => makeCompletion());
    const provider = makeProvider(mockCreate);

    await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
    });
    expect('tools' in (mockCreate.mock.calls[0]?.[0] ?? {})).toBe(false);

    await provider.complete({
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      maxTokens: 50,
      tools: [],
    });
    expect('tools' in (mockCreate.mock.calls[1]?.[0] ?? {})).toBe(false);
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

  it('handles missing finish_reason gracefully', async () => {
    const mockCreate = vi.fn(async () =>
      makeCompletion({}, { finish_reason: null as unknown as 'stop' }),
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
