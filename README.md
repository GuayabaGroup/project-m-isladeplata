# Isladeplata

Agente conversacional de atención al cliente para Project-M. Reemplaza la capa conversacional del IDP v2 con **LangGraph + TypeScript**.

Atiende dos públicos por **WhatsApp dual**:
- **Clientes finales**: agendar, reagendar, cancelar, confirmar turnos, consultas (precios, horarios, servicios).
- **Staff del negocio**: agenda, resúmenes, queries operativas.

Diseñado canal-agnóstico — el próximo canal (Telegram, web, mobile) se enchufa sin tocar el grafo.

## Arquitectura

```
[Webhook canal] → Pre-graph (auth, identity, dedup, rate limit, thread)
                     ↓
              [Supervisor] (clasifica intent, atajos para button payloads)
                     ↓
        ┌────────────┴────────────┐
        ↓                         ↓
 [Tools atómicas]          [Subgrafos] (schedule, reschedule, cancel, query)
   (system, support)         con interrupts + checkpointer Postgres
```

Ver detalle en [`docs/REGLAS_ISLADEPLATA.md`](docs/REGLAS_ISLADEPLATA.md) (canon) y [`docs/SPRINT.md`](docs/SPRINT.md) (plan).

## Backends

Sin Postgres del negocio. Toda data por HTTP a:
- **Guacuco** ([`../project-m-guacuco`](../project-m-guacuco)) — turnos, identity, disponibilidad, ejecución de tools.
- **Parguito** — CRM context (stub Etapa 3).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
```

Para desarrollo: `pnpm dev`.

## Status

H0 (setup foundation) completado. Ver `CLAUDE.md` para el progreso por hito.
