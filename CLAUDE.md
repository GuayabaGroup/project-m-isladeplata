# Isladeplata — agente conversacional

Atención al cliente (clientes finales + staff de los negocios) sobre WhatsApp dual cliente/staff. Construido con **LangGraph + TypeScript** sobre **Node 22**, ESM NodeNext puro.

## Lectura obligatoria antes de tocar el repo

[`docs/REGLAS_ISLADEPLATA.md`](docs/REGLAS_ISLADEPLATA.md) — reglas canónicas en 16 secciones (arquitectura, dirección de dependencias, anti-alucinación, supervisor+subgrafos, canales, seguridad, errores, logging, testing, checklist NUNCA/SIEMPRE).

Toda auditoría de código contra ese documento. Un hallazgo de auditoría es válido solo si viola una regla documentada ahí.

## Sprint v1

[`docs/SPRINT.md`](docs/SPRINT.md) — 9 hitos H0 → H8. Specs para el equipo Guacuco (P1 idempotency, P2 persistencia turnos) en [`docs/specs/`](docs/specs/). P3 fue descartada en H6 — Guacuco ya tenía el tool `validate_reschedule_slot` legacy que cubre el caso.

Features intencionalmente excluidas de v1 (con trigger para reabrir): [`docs/PENDING_ITER2.md`](docs/PENDING_ITER2.md).

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
- **H3.A — Checkpointer Postgres + LangSmith + grafo dummy** ✅
- **H3.B — Supervisor LLM + tools atómicas + atajos button** ✅
- **H3 — Grafo base + supervisor + tools atómicas** ✅
- **H4 — Subgrafo `schedule_appointment`** ✅
- **H5 — Subgrafos `confirm` + `cancel`** ✅
- **H6 — Subgrafo `reschedule`** ✅ (P3 descartada — Guacuco ya tenía el tool legacy correcto)
- **H7 — Subgrafo `query`** ✅ (4 intents fijos + freeform_sql via port de IDP_OV1; sin QueryJudge ni drill-down iter 1)
- **H8.1 — Persistencia turnos (P2 wire fire-and-forget)** ✅
- **H8.2 — Métricas (prom-client + Sentry spans + /metrics endpoint)** ✅
- **H8.3 — Cutover docs (`docs/RUNBOOK_CUTOVER.md`)** ✅ (scope reducido: cutover directo sin router dual ni rollout gradual)
- H8.4 — primer mensaje real en producción + observación 24h

Actualizar este checklist a medida que se completen hitos.

## Cómo arrancar una sesión nueva

1. Abrir el chat en este directorio (`project-m-isladeplata`). El sistema carga `MEMORY.md` (índice) + este `CLAUDE.md` automáticamente.
2. Frase recomendada: **"Vamos a seguir con HX (o subhito)"**. Ejemplo: *"Sigamos con H3.B"*. Eso me dispara a leer:
   - `docs/SPRINT.md` (sección del hito)
   - Memoria operacional del estado (ver [[project-h3a-state-and-h3b-plan]] cuando exista)
   - `git log -5` para confirmar el último commit
   - Cualquier memoria referenciada por las anteriores
3. Si querés que use comportamiento distinto al default ("revisar primero", "no editar nada hasta acordar"), decilo explícito al inicio.
4. Si una memoria contradice el código actual, **el código gana** — yo actualizo la memoria al detectarlo.
