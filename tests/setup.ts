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
