import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { parseLlmJson } from '../../../src/core/parseLlmJson.js';

const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ctx = { component: 'test' };

describe('parseLlmJson', () => {
  it('parses raw JSON object', () => {
    const out = parseLlmJson<{ a: number }>('{"a": 1}', mockLogger, ctx);
    expect(out).toEqual({ a: 1 });
  });

  it('parses raw JSON array', () => {
    const out = parseLlmJson<number[]>('[1,2,3]', mockLogger, ctx);
    expect(out).toEqual([1, 2, 3]);
  });

  it('extracts JSON from ```json fenced markdown', () => {
    const raw = 'Sure, here is the result:\n```json\n{"messageType":"greeting"}\n```';
    const out = parseLlmJson<{ messageType: string }>(raw, mockLogger, ctx);
    expect(out).toEqual({ messageType: 'greeting' });
  });

  it('extracts JSON from unlabeled ``` fenced block', () => {
    const raw = 'Result:\n```\n{"x": 42}\n```';
    const out = parseLlmJson<{ x: number }>(raw, mockLogger, ctx);
    expect(out).toEqual({ x: 42 });
  });

  it('extracts JSON object embedded in prose', () => {
    const raw =
      'Based on the input, my classification is {"messageType":"action","confidence":0.8} done.';
    const out = parseLlmJson<{ messageType: string; confidence: number }>(raw, mockLogger, ctx);
    expect(out).toEqual({ messageType: 'action', confidence: 0.8 });
  });

  it('handles JSON with nested braces in strings', () => {
    const raw = 'Here: {"a":"{nested}","b":1}';
    const out = parseLlmJson<{ a: string; b: number }>(raw, mockLogger, ctx);
    expect(out).toEqual({ a: '{nested}', b: 1 });
  });

  it('handles JSON with escaped quotes', () => {
    const raw = '{"text":"he said \\"hi\\""}';
    const out = parseLlmJson<{ text: string }>(raw, mockLogger, ctx);
    expect(out).toEqual({ text: 'he said "hi"' });
  });

  it('returns null for empty string', () => {
    const out = parseLlmJson('', mockLogger, ctx);
    expect(out).toBeNull();
  });

  it('returns null for whitespace only', () => {
    const out = parseLlmJson('   \n  ', mockLogger, ctx);
    expect(out).toBeNull();
  });

  it('returns null for non-string input', () => {
    // biome-ignore lint/suspicious/noExplicitAny: edge-case input
    const out = parseLlmJson(undefined as any, mockLogger, ctx);
    expect(out).toBeNull();
  });

  it('returns null for prose without any JSON', () => {
    const out = parseLlmJson('I am happy to help!', mockLogger, ctx);
    expect(out).toBeNull();
  });

  it('returns null for malformed JSON (unbalanced braces)', () => {
    const out = parseLlmJson('{"a": 1', mockLogger, ctx);
    expect(out).toBeNull();
  });

  it('parses first complete JSON object when multiple are present', () => {
    const raw = '{"a":1} extra text {"b":2}';
    const out = parseLlmJson<{ a: number }>(raw, mockLogger, ctx);
    expect(out).toEqual({ a: 1 });
  });

  it('parses nested object correctly', () => {
    const raw = '{"outer":{"inner":{"deep":true}}}';
    const out = parseLlmJson<{ outer: { inner: { deep: boolean } } }>(raw, mockLogger, ctx);
    expect(out).toEqual({ outer: { inner: { deep: true } } });
  });
});
