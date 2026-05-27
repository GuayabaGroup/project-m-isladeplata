// Inyecta env vars dummy ANTES de cualquier import del source. Imprescindible
// porque `src/config/env.ts` parsea con Zod en el import-time y termina el
// proceso con exit(1) si la validación falla — sin estas líneas todos los
// tests caen con exit code 1 al cargar.
//
// Si añadís una env var nueva en `src/config/env.ts` con default, no hace
// falta tocar acá. Si NO tiene default, agregala con un valor dummy válido.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.SENTRY_DSN = process.env.SENTRY_DSN ?? '';

// LangSmith desactivado en tests por default — los runs no deben enviarse al
// servicio externo durante CI. Si alguien quiere test contra LangSmith real,
// puede setear las vars antes de correr vitest.
process.env.LANGSMITH_TRACING = process.env.LANGSMITH_TRACING ?? 'false';
process.env.LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY ?? '';
process.env.LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT ?? 'isladeplata-test';
process.env.LANGSMITH_HIDE_INPUTS = process.env.LANGSMITH_HIDE_INPUTS ?? 'false';
process.env.LANGSMITH_HIDE_OUTPUTS = process.env.LANGSMITH_HIDE_OUTPUTS ?? 'false';

// HTTP clients — dummies en tests para que env.ts no falle al cargar.
// Los tests unitarios mockean el RetryClient y nunca tocan estas URLs.
process.env.GUACUCO_URL = process.env.GUACUCO_URL ?? 'http://localhost:4001';
process.env.GUACUCO_API_KEY = process.env.GUACUCO_API_KEY ?? 'test-guacuco-key';
process.env.GUACUCO_TIMEOUT_MS = process.env.GUACUCO_TIMEOUT_MS ?? '5000';
process.env.PARGUITO_URL = process.env.PARGUITO_URL ?? 'http://localhost:4002';
process.env.PARGUITO_API_KEY = process.env.PARGUITO_API_KEY ?? 'test-parguito-key';
process.env.PARGUITO_TIMEOUT_MS = process.env.PARGUITO_TIMEOUT_MS ?? '5000';

// HTTP + Redis + WhatsApp (H2)
process.env.PORT = process.env.PORT ?? '4000';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.DEDUP_TTL_SECONDS = process.env.DEDUP_TTL_SECONDS ?? '300';
process.env.RATE_LIMIT_MAX_PER_MINUTE = process.env.RATE_LIMIT_MAX_PER_MINUTE ?? '20';
process.env.WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? 'test-verify-token';
process.env.WHATSAPP_GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? 'v22.0';
process.env.WHATSAPP_CHANNEL_MAP_JSON = process.env.WHATSAPP_CHANNEL_MAP_JSON ?? '{}';
process.env.APP_SECRET_BY_PLATFORM_JSON = process.env.APP_SECRET_BY_PLATFORM_JSON ?? '{}';
