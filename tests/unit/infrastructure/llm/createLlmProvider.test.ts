import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type { Env } from '../../../../src/config/env.js';
import { AnthropicProvider } from '../../../../src/infrastructure/llm/AnthropicProvider.js';
import { OpenAIProvider } from '../../../../src/infrastructure/llm/OpenAIProvider.js';
import { createLlmProvider } from '../../../../src/infrastructure/llm/createLlmProvider.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function baseEnv(): Env {
  return {
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    OPENAI_API_KEY: 'test-openai-key',
    SUPERVISOR_MODEL: 'claude-haiku-4-5-20251001',
    RESPONSE_MODEL: 'claude-haiku-4-5-20251001',
    OPENAI_SUPERVISOR_MODEL: 'gpt-4o-mini',
    OPENAI_RESPONSE_MODEL: 'gpt-4o-mini',
  } as unknown as Env;
}

describe('createLlmProvider', () => {
  it('returns AnthropicProvider when LLM_PROVIDER=anthropic', () => {
    const env = { ...baseEnv(), LLM_PROVIDER: 'anthropic' as const };
    const provider = createLlmProvider(env, mockLogger);
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('returns OpenAIProvider when LLM_PROVIDER=openai', () => {
    const env = { ...baseEnv(), LLM_PROVIDER: 'openai' as const };
    const provider = createLlmProvider(env, mockLogger);
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('throws when LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty', () => {
    const env = { ...baseEnv(), LLM_PROVIDER: 'anthropic' as const, ANTHROPIC_API_KEY: '' };
    expect(() => createLlmProvider(env, mockLogger)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws when LLM_PROVIDER=openai but OPENAI_API_KEY is empty', () => {
    const env = { ...baseEnv(), LLM_PROVIDER: 'openai' as const, OPENAI_API_KEY: '' };
    expect(() => createLlmProvider(env, mockLogger)).toThrow(/OPENAI_API_KEY/);
  });
});
