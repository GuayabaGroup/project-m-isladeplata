# Sprint — Isladeplata v1

> Plan de codificación de Isladeplata (agente conversacional con LangGraph + TS). 9 hitos del setup base al cutover en producción, paralelizados con cambios en Guacuco (specs P1–P3 en `docs/specs/`).
>
> Documento canónico del sprint v1. Cualquier cambio de alcance, orden o DoD requiere actualizar este archivo.

---

## Resumen ejecutivo

| # | Hito | Bloqueo Guacuco | Output validable |
|---|---|---|---|
| 0 | Setup foundation | — | typecheck + CI verde |
| 1 | HTTP clients hacia Guacuco/Parguito | — | smoke test resolveIdentity |
| 2 | Canal WhatsApp + pre-grafo (sin grafo) | — | echo response end-to-end |
| 3 | Grafo base + supervisor + tools atómicas | — | "quiero el link" → URL Manzanillo |
| 4 | **Subgrafo schedule** (validador del diseño) | **P1 idealmente listo** | turno agendado end-to-end con todas las ramas |
| 5 | Subgrafos confirm + cancel | P1 | confirmar + cancelar end-to-end |
| 6 | Subgrafo reschedule | **P3 requerido** | reagendar end-to-end |
| 7 | Subgrafo query (text-to-data) | — | "cuánto cuesta corte" responde |
| 8 | Persistencia turnos + cutover | **P2 requerido** | 1 negocio piloto sin regresiones |

```
Guacuco team:           [— P1 —][— P3 —][——————— P2 ———————]
Isladeplata team: [H0][H1][H2][H3][———— H4 ————][H5][H6][H7][— H8 —]
                                       ↑                 ↑           ↑
                                       P1 listo          P3 listo    P2 listo
```

---

## Hito 0 — Setup foundation

**Objetivo**: dejar el repo listo para que los hitos siguientes solo agreguen funcionalidad sin tocar infra base.

**Entregables**:
- Repo init con Node 22 + TS 5.x strict + ESM NodeNext.
- `tsconfig.json`, `package.json`, `vitest.config.ts`.
- `src/config/env.ts` (Zod fail-fast).
- `tests/setup.ts` (env vars dummy).
- `src/core/{types,enums,errors}/` con shapes base (`ChannelMessage`, `Identity`, `IdpError`, `ToolExecutionError`, `IdentityNotFoundError`).
- `src/security/`: `hmac.ts`, `sanitize.ts`, `validateWebhookSignature.ts`.
- `src/infrastructure/observability/`: `logger.ts` (Winston), `sentry.ts`, `swallowAsync.ts`.
- `src/infrastructure/http/`: `RetryClient.ts`, middleware básico.
- `CLAUDE.md` apuntando a `docs/REGLAS_ISLADEPLATA.md`.
- CI: typecheck + lint + test.

**DoD**: `npm run typecheck && npm test` verde en CI.

**Spike técnico paralelo (no bloquea)**: validar que LangGraph TS soporta lo crítico (interrupts, checkpointer Postgres, channels tipados, subgrafos como nodos). Si hay gaps, documentar workarounds antes de H3.

---

## Hito 1 — HTTP clients hacia Guacuco/Parguito

**Objetivo**: capa de acceso a backends propios sólida y testeada, lista para que el pre-grafo y los nodos del grafo solo orquesten.

**Entregables**:
- `src/clients/BaseHttpClient.ts` con retry + envelope unwrap.
- `src/clients/GuacucoClient.ts` con:
  - `resolveIdentity(channelType, channelId, phoneNumberId)`
  - `validateTool(toolName, parameters, context)` (schedule; reschedule cuando P3 esté)
  - `executeTool(toolName, parameters, context, idempotencyKey?)` (schedule, cancel, reschedule, confirm)
  - `checkAvailability(...)` (Modes A/B/C de `CheckAvailabilityToolHandler`)
- `src/clients/ParguitoClient.ts` con `getCrmContext` retornando defaults stub.
- DTOs tipados en `clients/types/`.
- Tests unitarios contra mocks de envelope (happy + 4 ramas de error).
- (Opcional) script `scripts/smoke-guacuco.ts` para validar contra Guacuco staging.

**DoD**: `tsx scripts/smoke-guacuco.ts` resuelve identity de un número de prueba y prints output completo.

---

## Hito 2 — Canal WhatsApp + pre-grafo (sin grafo)

**Objetivo**: end-to-end conexión Meta → isladeplata → Meta funciona, identity resuelta correctamente, dedup y rate limit operativos. **Sin grafo todavía** — solo echo response.

**Entregables**:
- `src/channels/whatsapp/`: webhook (verify HMAC + responder 200 inmediato), normalizer (payload → ChannelMessage con `whatsappChannel: 'staff'|'client'`), sender.
- `src/config/channels.config.ts` con `WHATSAPP_CHANNEL_MAP` + `APP_SECRET_BY_PLATFORM`.
- `src/infrastructure/redis/`: `DedupStore`, `RateLimitStore` (con `SCAN` no `KEYS`, TTLs explícitos).
- `src/pregraph/pipeline.ts` con pasos 1-5 + 9 de §7 REGLAS (sin invocar grafo todavía): verify → normalize → dedup → identity → rate limit → echo response.
- `src/nlg/ResponseBuilder.ts` con `CHANNEL_FORMATS` para WhatsApp.
- Welcome flow: staff `isNewUser=true` → mensaje con `onboardingUrl`. Cliente sin business → silent skip.
- Tests + smoke test end-to-end.

**DoD**:
- Envío "hola" a número WhatsApp de prueba → respuesta echo correcta con identity resuelta.
- Mensaje duplicado dentro de 5 min → ignorado (no responde 2 veces).
- 21º mensaje en 60 s → rate limit response.
- Staff nuevo recibe mensaje con `onboardingUrl`.

---

## Hito 3 — Grafo base + supervisor + tools atómicas

**Objetivo**: el grafo está vivo, los flujos sin estado (tools atómicas, fast-path social) funcionan, checkpointer Postgres validado, atajos de button payload funcionando.

**Entregables**:
- `src/infrastructure/checkpointer/`: Postgres pool dedicado + LangGraph `PostgresSaver` (vía `@langchain/langgraph-checkpoint-postgres`) + `await saver.setup()` al boot + TTL inline al lookup + job de cleanup periódico.
- `src/infrastructure/tracing/langsmith.ts`: inicialización opt-in según `LANGSMITH_TRACING`. Si activo sin API key → `warn` log, no romper. Helper `traceable()` wrapper para spans fuera del grafo si hace falta.
- `src/graph/state.ts` con channels y reducers (`messages`, `input`, `identity`, `crmContext`, `routing`, `subgraphState`, `outcome`).
- `src/graph/compile.ts`.
- `src/graph/supervisor/`: clasificador Haiku + fast-path social + atajo determinístico para button payloads (`confirm:`, `cancel:`, `slot_pick:`) + filtrado de tools por rol.
- `src/graph/tools/system/`: `retrieve_manzanillo_url`, `generate_verification_url`, `connect_mercado_pago` (tools atómicas, sin interrupts).
- `src/graph/tools/support/`: `forward_message`.
- Integración con pre-grafo (paso 8): invoke + dispatch outcome.
- `src/pregraph/ThreadResolver.ts` con verificación TTL inline.
- Tests + integration test happy path.
- LangSmith dashboard validado: traces de invokes del grafo aparecen en proyecto `isladeplata-dev`.

**DoD**:
- Cliente envía "hola" → respuesta social Haiku.
- Cliente envía "quiero el link" → `retrieve_manzanillo_url` se ejecuta, responde con URL.
- Mensaje fuera de scope → respuesta amable, no error.
- Thread interrupted recuperado correctamente al reanudar (test simulando interrupt + Command(resume)).
- Tap de button `confirm:<uuid>` → reanuda sin invocar LLM (atajo determinístico).

---

## Hito 4 — Subgrafo `schedule_appointment`

**Objetivo**: el subgrafo más complejo del agente — donde se valida que el diseño completo funciona. Si algo del approach falla, sale acá. **El patrón que se establezca acá se reusa en H5–H7.**

**Entregables**:
- `src/graph/subgraphs/schedule/state.ts`: `AppointmentDraftState` (slots, availability, confirmation, phase, meta).
- `src/graph/subgraphs/schedule/nodes/`:
  - `entry` — pre-fill desde entidades NLU
  - `resolve_entities` — fuzzy match local sobre `helpersLists` (no llama a Guacuco)
  - `check_completeness` — función pura
  - `ask_slot` — LLM + `interrupt()`
  - `validate_availability` — Guacuco `/tools/validate` con `tool_name='schedule_appointment'`
  - `availability_router`
  - `present_options` — `interrupt()` con list de WhatsApp
  - `build_confirm_message` — Haiku, recibe solo `displayName`s
  - `gate_confirm` — `interrupt()` + button IDs `confirm:<intentUuid>` / `cancel:<intentUuid>`
  - `commit` — Guacuco `/tools/execute` con `idempotency_key=intentUuid`
  - `success_response`, `error_handler`
- `src/graph/nodes/parseUserSlotReply.ts` (función pura para fechas/horas).
- Reducer de slots con tipos enforzados.
- Assertion `status==='resolved'` antes de `commit` con `IdpError('invariant_violated')` si falla.

**Tests críticos**:
1. Happy path: usuario manda todo en un mensaje → commit OK.
2. Slot faltante → ask → resolve → confirm → commit.
3. Slot no disponible → `present_options` (3 sugerencias) → user picks → confirm → commit.
4. Race en commit (`STAFF_NOT_AVAILABLE`) → vuelve a `validate_availability` con nuevas sugerencias.
5. Cancel implícito mid-confirm (usuario manda texto libre) → vuelve a collecting, slots preservados.
6. Anti-alucinación: commit con slot no `resolved` → `IdpError('invariant_violated')`.
7. Guard anti-loop: `attempts > N` → `outcome.action='handed_off'`.
8. Multi-service: array `service_uuids` con 2+ elementos.
9. Cambio de slot mid-confirm: usuario dice "mejor a las 17" → reducer invalida `availability` + `confirmation`, re-valida.
10. Identity dual: staff agendando para cliente con `clientUuid` extra slot.

**DoD**: cliente real puede agendar un turno end-to-end via WhatsApp con las 10 ramas anteriores validadas. **Requiere P1 desplegado en Guacuco** para protección anti-doble-creación.

---

## Hito 5 — Subgrafos `confirm` + `cancel`

**Objetivo**: validar que el patrón establecido en H4 se reusa con bajo costo.

**Entregables**:
- `src/graph/subgraphs/confirm/`: 1 slot `appointment_uuid`, sin `requiresConfirmation` (la tool es confirmatoria por sí misma).
- `src/graph/subgraphs/cancel/`: 1 slot `appointment_uuid`, CON `requiresConfirmation`.
- Bootstrap del intent desde `crmContext.upcomingAppointments` (pre-fill si hay un solo turno próximo).
- Tests análogos a H4 con casos relevantes.

**DoD**: agendar + confirmar + cancelar funciona end-to-end. Test de bootstrap pre-fill ("cancelá el de mañana" + 1 upcoming → directo al gate_confirm).

---

## Hito 6 — Subgrafo `reschedule`

**Bloqueo**: P3 (validate genérico para reschedule) desplegado en Guacuco.

**Objetivo**: validar que `schedule` y `reschedule` comparten ~80% del grafo.

**Entregables**:
- `src/graph/subgraphs/reschedule/` reusando nodos de `schedule` (`resolve_entities`, `validate_availability`, `present_options`, `gate_confirm`).
- State extiende con `appointment_uuid` (referencia al turno existente), `new_date`, `new_time`.
- `validate_availability` pasa `appointment_uuid` en context (excluye el slot propio en Guacuco).
- Bootstrap: "cambiar el de mañana" + un solo upcoming → pre-fill `appointment_uuid`.

**DoD**: usuario reagenda turno via WhatsApp con sugerencias si hay conflicto. Test de "reagendar a la misma hora del propio appointment" → válido.

---

## Hito 7 — Subgrafo `query` (text-to-data)

**Objetivo**: queries informativas (precio, horarios, próximos turnos) funcionan.

**Entregables**:
- `src/graph/subgraphs/query/` con dos nodos LLM:
  - `generate_sql` (Sonnet) sobre schema dinámico cargado en state
  - `synthesize_answer` (Haiku) que toma resultado y formula respuesta
- Cap de costo / timeout por query.
- Tests con queries comunes:
  - "cuánto cuesta un corte" (cliente)
  - "qué horarios tengo el viernes" (staff)
  - "qué servicios ofrecen" (cliente)

**DoD**: las 3 queries anteriores responden correctamente. Query sin match en schema → respuesta amable de "no puedo responder eso".

---

## Hito 8 — Persistencia turnos + cutover

**Bloqueo**: P2 (endpoint persistir turnos) desplegado en Guacuco.

**Objetivo**: producción.

**Entregables**:
- Fire-and-forget al final de cada turno → `POST /api/v1/conversations/agent-turns`.
- Métricas (Sentry / Sentry Performance / dashboard interno):
  - turnos procesados por intent clasificado
  - subgrafo activado
  - latencia p50/p95
  - error rate por componente
  - commits exitosos
- Feature flag por `business_uuid` para routear webhook a isladeplata o IDP v2.
- Rollout plan: 1 piloto → 5 → 20 → todos.
- Runbook de rollback: flip flag, threads pausados quedan en checkpointer hasta TTL (24h), agente vuelve a comportamiento IDP v2 sin pérdida de datos del negocio.

**DoD**: 1 negocio piloto corriendo en isladeplata 1 semana sin regresiones críticas. Comparativa side-by-side de turnos creados vs IDP v2 muestra paridad funcional.

---

## Scope de v1

### IN
- WhatsApp dual cliente/staff (Allia, Groomia, Divapp)
- Schedule, reschedule, cancel, confirm
- Query (text-to-data básico)
- System tools (URLs, mercadopago)
- Forward message
- Fast-path social (greeting/farewell/oos)

### OUT (post v1)
- Telegram / mobile / web (canal-agnóstico de arquitectura, no de implementación)
- Schedule con depósito (requiere P4 capabilities + subgrafo `schedule_with_deposit`)
- `get_staff_appointments_summary` (puede entrar en H5/H6 si decisión)
- Recovery poller / fallback storage (eliminado por checkpointer Postgres)
- Domain events cross-canal (post v1)

---

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| LangGraph TS tiene gaps vs Python (más maduro) | Media | Spike técnico en H0 para validar features críticas. Si hay gaps, documentar workarounds antes de H3. |
| H4 destapa que el state design no escala | Media | H4 es deliberadamente el primer subgrafo. Si refactor → impacta solo a 1 subgrafo, no a 4. |
| Cutover (H8) revela diferencias sutiles con IDP v2 (UX) | Alta | Piloto con 1 negocio + métricas durante 1 semana antes de expandir. Comparativa side-by-side de turnos en dashboard. |
| Modelo Haiku del supervisor clasifica mal handoff cross-intent | Media | Atajos determinísticos para button payloads. Tests dedicados de clasificación. Quality gate post-clasificación si hace falta. |
| P1/P2/P3 atrasan respecto a hitos isladeplata | Media | Trade-offs documentados: H4 puede empezarse sin P1 (idempotency es protección, no funcionalidad). H6 puede usar `validate_reschedule_slot` legacy si P3 demora. H8 no se puede hacer sin P2. |

---

## Cambios a este documento

Cada vez que se modifique el plan (alcance, orden, DoD, scope), el PR debe incluir actualización de este archivo y justificación. Las decisiones tomadas hasta el 2026-05-27 quedan congeladas en este documento; cambios posteriores se registran en commits con razón explícita.
