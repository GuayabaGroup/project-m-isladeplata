# Tareas — P-human-takeover (Isladeplata `--i`)

> Spec: `docs/specs/P-human-takeover.md`. Takeover humano manual (bot mute).
> Scope: lado **isladeplata** (Guacuco BLOQUEADO — solo se cablea el contrato HTTP
> del lado del cliente; el POST es fire-and-forget y tolera que el endpoint no exista).
>
> Decisiones del owner (2026-05-28):
> - Capas **A + B + C** (C detrás de `TAKEOVER_SENTIMENT_ENABLED`, default off).
> - Turno que dispara: **respuesta cortés de handoff**, luego el gate silencia.
> - Conflicto con interrupt pendiente: **dejar el checkpoint**, el gate silencia (retoma al reactivar).

---

## Diseño clave

- **Señal capa A/C → pipeline**: campo opcional `outcome.takeover = { reasonCode }`.
  Se piggybackea en `outcome` (que ya es fresco por turno — el dispatch depende de
  ello), evitando un channel nuevo del state propenso a staleness.
- **Capa B**: detectada y disparada 100% en el pipeline (contador Redis), sin tocar el grafo.
- **Disparo fire-and-forget**: `TakeoverNotifier` → `POST /conversations/takeover` +
  `mirrorActive` SOLO si el POST resolvió (si Guacuco cae, el bot sigue atendiendo).
- **Gate**: lee espejo Redis; repuebla/invalida desde `identity.humanControlled` (campo
  nuevo opcional de resolveIdentity; ausente hoy → gobierna el TTL del espejo).

## Checklist

### Config / env
- [ ] `config/env.ts`: `HUMAN_TAKEOVER_ENABLED`, `TAKEOVER_SENTIMENT_ENABLED`,
      `TAKEOVER_FAILS_THRESHOLD` (3), `TAKEOVER_TTL_SECONDS` (21600).
- [ ] `tests/setup.ts`: las 4 vars (overridables por tests).
- [ ] `.env.example`: las 4 vars documentadas.

### core
- [ ] `core/enums/TakeoverReason.ts`: `TAKEOVER_REASON_CODES` + `TakeoverReasonCode`.
- [ ] `core/types/Outcome.ts`: `takeover?: { reasonCode }` + interface `TakeoverTrigger`.

### infrastructure
- [ ] `infrastructure/redis/TakeoverStore.ts`: `isHumanControlled`, `mirrorActive`,
      `clear`, `bumpFailures`, `resetFailures` (TTL explícito, patrón DedupStore).
- [ ] `infrastructure/observability/metrics.ts`: `takeoverTotal{reason_code,result}` +
      `takeoverMutedTotal{channel}` + reset.

### clients
- [ ] `clients/types/GuacucoTypes.ts`: `TriggerTakeoverRequest`/`Result` + `humanControlled`
      en raw + output de resolveIdentity.
- [ ] `clients/mappers/IdentityMapper.ts`: mapear `human_controlled` (defensivo, opcional).
- [ ] `clients/GuacucoClient.ts`: `triggerTakeover(payload)` (path `/api/v1/conversations/takeover`).

### pregraph
- [ ] `pregraph/TakeoverNotifier.ts`: trigger fire-and-forget (POST + mirror + counter, swallows).
- [ ] `pregraph/pipeline.ts`: gate (4.5) + capa B (post-dispatch) + disparo capa A/C (outcome.takeover).

### graph (capas A + C)
- [ ] `graph/state.ts`: `MessageType += 'human_request'`, `RoutingState.takeoverReason?`.
- [ ] `graph/supervisor/classifyIntent.ts`: prompt + valid set condicional (humanRequestEnabled);
      al detectar → `takeoverReason='explicit_request'`.
- [ ] `graph/supervisor/router.ts`: `human_request` → `request_human`.
- [ ] `graph/supervisor/requestHuman.ts`: nodo handoff (reply canned + `outcome.takeover`).
- [ ] `graph/supervisor/detectFrustration.ts`: juez LLM (capa C) → `takeoverReason='sentiment_frustration'`.
- [ ] `graph/compile.ts`: wiring condicional de `request_human` (si takeover on) y
      `detect_frustration` (si takeover+sentiment on). Grafo idéntico a hoy si flag off.

### bootstrap
- [ ] `main/bootstrap.ts`: construir `TakeoverStore` + `TakeoverNotifier`, inyectar a Pipeline.

### tests
- [ ] TakeoverStore, triggerTakeover (GuacucoClient), TakeoverNotifier (fire-and-forget),
      gate (silencia + persiste + métrica), capa B (umbral), classify human_request,
      requestHuman, detectFrustration, IdentityMapper humanControlled.

### Cierre
- [x] `pnpm typecheck` + `pnpm lint` + `pnpm test` verdes (778 tests, +36).
- [x] Auditoría REGLAS_ISLADEPLATA (ver review abajo).

---

## Review

**Estado**: completo. Todos los ítems implementados y verificados.

**Desvío de diseño vs plan**: en vez de agregar 2 nodos al grafo (`request_human`
+ `detect_frustration`), se agregaron 0 nodos — chocaban con TS2589 (límite de
profundidad de tipos de LangGraph a ~44 nodos). Capa A emite el messageType
`human_request` que rutea a `social_responder` (handoff canned + `outcome.takeover`);
capa C es un juez (`makeFrustrationJudge`) inyectado dentro de `classify_intent`.
Mismo comportamiento, sin tocar el wiring del grafo. Ver [lessons.md](lessons.md).

**Verificación**:
- `pnpm typecheck` ✓ · `pnpm lint` ✓ (240 files) · `pnpm build` ✓ · `pnpm test` ✓ (778).
- Tests nuevos: TakeoverStore (6), TakeoverNotifier (4), GuacucoClient.triggerTakeover
  + humanControlled mapping (5), pipeline gate/capa A/B (8), classify capa A/C (5),
  socialResponder handoff (2), detectFrustration judge (6), router (1).
- DoD cubierto: gate silencia (ignored + persistido) en `human_controlled`; disparo
  fire-and-forget resuelve aunque Guacuco falle; capa C detrás de flag (default off).

**Pendiente (fuera de scope `--i`, bloqueado en Guacuco)**:
- Endpoint `POST /api/v1/conversations/takeover` + flag `human_controlled` en
  `resolveIdentity` con idempotencia/TTL server-side. El cliente HTTP ya está listo.
- Dashboard: cola visible de conversaciones en `human_controlled` (hueco abierto §spec).
