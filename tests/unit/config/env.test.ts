import { describe, expect, it } from 'vitest';
import { envSchema } from '../../../src/config/env.js';

/**
 * Construye un objeto "process.env-like" que pasa la validación base.
 * Los tests overridean campos específicos para probar los refines cruzados.
 */
function baseRawEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    GUACUCO_URL: 'http://localhost:4001',
    GUACUCO_API_KEY: 'k',
    PARGUITO_URL: 'http://localhost:4002',
    PARGUITO_API_KEY: 'k',
    REDIS_URL: 'redis://localhost:6379',
    WHATSAPP_VERIFY_TOKEN: 't',
    POSTGRES_URL: 'postgres://x',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
  };
}

describe('envSchema — WHATSAPP_SKIP_SIGNATURE prod guard', () => {
  it('accepts WHATSAPP_SKIP_SIGNATURE=true in development', () => {
    const result = envSchema.safeParse({
      ...baseRawEnv(),
      NODE_ENV: 'development',
      WHATSAPP_SKIP_SIGNATURE: 'true',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WHATSAPP_SKIP_SIGNATURE).toBe(true);
    }
  });

  it('accepts WHATSAPP_SKIP_SIGNATURE=true in test', () => {
    const result = envSchema.safeParse({
      ...baseRawEnv(),
      NODE_ENV: 'test',
      WHATSAPP_SKIP_SIGNATURE: 'true',
    });
    expect(result.success).toBe(true);
  });

  it('rejects WHATSAPP_SKIP_SIGNATURE=true in production', () => {
    const result = envSchema.safeParse({
      ...baseRawEnv(),
      NODE_ENV: 'production',
      WHATSAPP_SKIP_SIGNATURE: 'true',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.flatten().fieldErrors;
      expect(issues.WHATSAPP_SKIP_SIGNATURE?.[0]).toMatch(/forbidden.*production/i);
    }
  });

  it('accepts WHATSAPP_SKIP_SIGNATURE=false in production', () => {
    const result = envSchema.safeParse({
      ...baseRawEnv(),
      NODE_ENV: 'production',
      WHATSAPP_SKIP_SIGNATURE: 'false',
    });
    expect(result.success).toBe(true);
  });

  it('defaults to false when WHATSAPP_SKIP_SIGNATURE is unset', () => {
    const result = envSchema.safeParse(baseRawEnv());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.WHATSAPP_SKIP_SIGNATURE).toBe(false);
    }
  });
});
