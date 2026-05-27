import { describe, expect, it } from 'vitest';
import { env } from '../../../src/config/env.js';
import {
  RESPONSE_CONFIG,
  SOCIAL_CONFIG,
  SUPERVISOR_CONFIG,
} from '../../../src/config/llm.config.js';

describe('llm.config', () => {
  it('sources supervisor model from env (no hardcoding)', () => {
    expect(SUPERVISOR_CONFIG.model).toBe(env.SUPERVISOR_MODEL);
  });

  it('sources response/social model from env', () => {
    expect(RESPONSE_CONFIG.model).toBe(env.RESPONSE_MODEL);
    expect(SOCIAL_CONFIG.model).toBe(env.RESPONSE_MODEL);
  });

  it('supervisor uses low temperature for determinism', () => {
    expect(SUPERVISOR_CONFIG.temperature).toBeLessThanOrEqual(0.3);
  });

  it('response/social use higher temperature for variety', () => {
    expect(RESPONSE_CONFIG.temperature).toBeGreaterThan(SUPERVISOR_CONFIG.temperature);
    expect(SOCIAL_CONFIG.temperature).toBeGreaterThan(SUPERVISOR_CONFIG.temperature);
  });

  it('supervisor max tokens kept small (JSON output only)', () => {
    expect(SUPERVISOR_CONFIG.maxTokens).toBeLessThanOrEqual(512);
  });

  it('social has the smallest token budget (short replies)', () => {
    expect(SOCIAL_CONFIG.maxTokens).toBeLessThanOrEqual(RESPONSE_CONFIG.maxTokens);
  });
});
