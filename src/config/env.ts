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

  // HTTP server
  PORT: z.coerce.number().int().positive().default(4000),

  // Redis (dedup + rate limit únicamente; sesiones van al checkpointer Postgres en H3)
  REDIS_URL: z.string().min(1),
  DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(20),

  // WhatsApp Cloud API
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_GRAPH_API_VERSION: z.string().default('v22.0'),
  /**
   * JSON: `{ "<phone_number_id>": { "access_token": "...", "role": "staff"|"client", "platform_id": 1|2|3 }, ... }`
   * Parsed + validated en `src/config/channels.config.ts`.
   */
  WHATSAPP_CHANNEL_MAP_JSON: z.string().default('{}'),
  /**
   * JSON: `{ "1": "<app_secret_allia>", "2": "<app_secret_groomia>", "3": "<app_secret_divapp>" }`
   * Parsed + validated en `src/config/channels.config.ts`.
   */
  APP_SECRET_BY_PLATFORM_JSON: z.string().default('{}'),

  // Postgres del agente (checkpointer LangGraph; NUNCA Postgres del negocio)
  POSTGRES_URL: z.string().min(1),
  /** Hilos sin actividad por más tiempo que este TTL son tratados como expirados. */
  CHECKPOINTER_TTL_SECONDS: z.coerce.number().int().positive().default(86_400), // 24h
  /** Frecuencia del job que borra checkpoints viejos para no inflar la tabla. */
  CHECKPOINTER_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3_600),
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
