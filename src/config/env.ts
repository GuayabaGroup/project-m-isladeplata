import { config } from 'dotenv';
import { z } from 'zod';

config();

const boolFromString = z
  .union([z.literal('true'), z.literal('false'), z.literal('').transform(() => 'false')])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  SENTRY_DSN: z.string().default(''),

  // LangSmith — tracing de LangGraph/LangChain runs. Cuando TRACING=true y
  // API_KEY está presente, todo invoke del grafo se registra en el proyecto
  // LANGSMITH_PROJECT. HIDE_INPUTS / HIDE_OUTPUTS permiten omitir payloads
  // sensibles del registro (recomendado en producción).
  LANGSMITH_TRACING: boolFromString,
  LANGSMITH_API_KEY: z.string().default(''),
  LANGSMITH_PROJECT: z.string().default('isladeplata-dev'),
  LANGSMITH_ENDPOINT: z.string().url().optional(),
  LANGSMITH_HIDE_INPUTS: boolFromString,
  LANGSMITH_HIDE_OUTPUTS: boolFromString,

  // Guacuco — backend de turnos/identidad/operaciones (HTTP, sin Postgres directo)
  GUACUCO_URL: z.string().url(),
  GUACUCO_API_KEY: z.string().min(1),
  GUACUCO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Parguito — CRM (stub Etapa 3; cuando explota, ParguitoClient retorna defaults)
  PARGUITO_URL: z.string().url(),
  PARGUITO_API_KEY: z.string().min(1),
  PARGUITO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] validation failed:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
