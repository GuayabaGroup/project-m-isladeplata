# Isladeplata — agente conversacional

Atención al cliente (clientes finales + staff de los negocios) sobre WhatsApp dual cliente/staff. Construido con **LangGraph + TypeScript** sobre **Node 22**, ESM NodeNext puro.

## Lectura obligatoria antes de tocar el repo

[`docs/REGLAS_ISLADEPLATA.md`](docs/REGLAS_ISLADEPLATA.md) — reglas canónicas en 16 secciones (arquitectura, dirección de dependencias, anti-alucinación, supervisor+subgrafos, canales, seguridad, errores, logging, testing, checklist NUNCA/SIEMPRE).

Toda auditoría de código contra ese documento. Un hallazgo de auditoría es válido solo si viola una regla documentada ahí.

## Sprint v1

[`docs/SPRINT.md`](docs/SPRINT.md) — 9 hitos H0 → H8. Specs para el equipo Guacuco (P1 idempotency, P2 persistencia turnos, P3 unificar validate) en [`docs/specs/`](docs/specs/).

## Quick commands

```bash
pnpm install           # instala deps
pnpm dev               # local dev con tsx watch
pnpm build             # tsc → dist/
pnpm start             # node dist/main/server.js
pnpm test              # vitest run
pnpm test:watch        # vitest watch
pnpm typecheck         # tsc --noEmit
pnpm lint              # biome check
pnpm lint:fix          # biome check --write
```

## Convenciones críticas (atajos a las REGLAS)

- **Imports `.js` aunque el source sea `.ts`** (NodeNext + ESM puro).
- **Zero `any`**. Strict TypeScript. `import type` para tipos (enforzado por `verbatimModuleSyntax`).
- **No `pg`/`prisma`/`kysely`** desde código de negocio. Toda data va por Guacuco/Parguito vía HTTP. La única excepción es `src/infrastructure/checkpointer/` (Postgres del agente, NO del negocio).
- **No `axios` directo, no `@anthropic-ai/sdk` directo** — usar `RetryClient`/`BaseHttpClient` y `AnthropicProvider` (cuando se agreguen).
- **No `@langchain/langgraph` fuera de `graph/` + `pregraph/` + `infrastructure/checkpointer/`**.
- **Observability dual**: Sentry para errores no esperados, **LangSmith para tracing del grafo + LLM** (init opt-in vía `LANGSMITH_TRACING`). En producción: `LANGSMITH_HIDE_INPUTS=true` + project separado por entorno. Ver §13.6 REGLAS.
- **Tests fuera del source** (`tests/unit/`, `tests/integration/`). Vitest, no Jest. Imports explícitos desde `vitest`.
- Cualquier env var nueva: `src/config/env.ts` **+** `tests/setup.ts` **+** doc en `.env.example`.

## Estado de los hitos

- **H0 — Setup foundation** ✅
- **H1 — HTTP clients (Guacuco/Parguito)** ✅
- **H2 — Canal WhatsApp + pre-grafo (echo, sin grafo)** ✅
- H3 — Grafo base + supervisor + tools atómicas
- H4 — Subgrafo `schedule_appointment`
- H5 — Subgrafos `confirm` + `cancel`
- H6 — Subgrafo `reschedule` (requiere P3)
- H7 — Subgrafo `query`
- H8 — Persistencia turnos (P2) + cutover

Actualizar este checklist a medida que se completen hitos.
