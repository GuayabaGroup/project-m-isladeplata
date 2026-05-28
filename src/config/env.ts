import { config } from 'dotenv';
import { z } from 'zod';

config();

const boolFromString = z
  .union([z.literal('true'), z.literal('false'), z.literal('').transform(() => 'false')])
  .default('false')
  .transform((v) => v === 'true');

export const envSchema = z
  .object({
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

    // Parguito — CRM. Mientras esté en stub (`PARGUITO_ENABLED=false`), el
    // pre-grafo NO consulta el endpoint y pasa `EMPTY_CRM_CONTEXT` al grafo.
    // Cuando se habilite (`true`), `ParguitoClient` es estricto: cualquier fallo
    // propaga al pipeline (Sentry + outcome `error`).
    PARGUITO_URL: z.string().url(),
    PARGUITO_API_KEY: z.string().min(1),
    PARGUITO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    PARGUITO_ENABLED: boolFromString,

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

    // LLM — provider switch + creds + modelos por rol (§11 REGLAS).
    // `LLM_PROVIDER` selecciona la impl en runtime (`createLlmProvider`).
    // Keys/modelos del provider elegido deben estar seteados; los del otro
    // pueden quedar vacíos. Validación cruzada vive en `createLlmProvider`
    // (fail-fast con mensaje claro al boot si falta lo del provider activo).
    LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),

    // Anthropic
    ANTHROPIC_API_KEY: z
      .string()
      .default('')
      .refine((v) => v === '' || v.startsWith('sk-ant-') || v.startsWith('test-'), {
        message: 'ANTHROPIC_API_KEY must be empty or start with "sk-ant-" (or "test-" in test env)',
      }),
    /** Anthropic: clasificador de intent + fast-path social. Default Haiku 4.5. */
    SUPERVISOR_MODEL: z.string().default('claude-haiku-4-5-20251001'),
    /** Anthropic: generación de respuestas conversacionales. Default Haiku 4.5. */
    RESPONSE_MODEL: z.string().default('claude-haiku-4-5-20251001'),

    // OpenAI
    OPENAI_API_KEY: z
      .string()
      .default('')
      .refine((v) => v === '' || v.startsWith('sk-') || v.startsWith('test-'), {
        message: 'OPENAI_API_KEY must be empty or start with "sk-" (or "test-" in test env)',
      }),
    /** OpenAI: clasificador de intent + fast-path social. Default gpt-4o-mini. */
    OPENAI_SUPERVISOR_MODEL: z.string().default('gpt-4o-mini'),
    /** OpenAI: generación de respuestas conversacionales. Default gpt-4o-mini. */
    OPENAI_RESPONSE_MODEL: z.string().default('gpt-4o-mini'),

    /**
     * Auth para el endpoint `/metrics` (H8.2). Si vacío, el endpoint NO se
     * monta — útil para entornos donde Prometheus no se usa o queda detrás
     * de red privada con otro mecanismo. Si presente, requests deben
     * incluir header `X-Metrics-Key` matcheando este valor.
     */
    METRICS_API_KEY: z.string().default(''),

    /**
     * Dev-only: si `true`, el webhook de WhatsApp NO valida HMAC. Permite
     * trabajar localmente sin configurar `APP_SECRET_BY_PLATFORM_JSON`. El
     * `phone_number_id` sigue siendo obligatorio (debe existir en
     * `WHATSAPP_CHANNEL_MAP_JSON` para resolver role + platformId).
     *
     * PROHIBIDO en producción — el parse del env hace fail-fast si
     * `WHATSAPP_SKIP_SIGNATURE=true` y `NODE_ENV=production`. Cada request en
     * modo skip emite un `warn` ruidoso para que sea imposible de no notar.
     */
    WHATSAPP_SKIP_SIGNATURE: boolFromString,
  })
  .superRefine((data, ctx) => {
    if (data.WHATSAPP_SKIP_SIGNATURE && data.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_SKIP_SIGNATURE'],
        message: 'WHATSAPP_SKIP_SIGNATURE=true is forbidden when NODE_ENV=production',
      });
    }
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
