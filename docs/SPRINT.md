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
| 6 | Subgrafo reschedule | ~~P3~~ legacy `validate_reschedule_slot` ✅ | reagendar end-to-end |
| 7 | Subgrafo query (4 intents fijos, sin freeform) | — | "cuánto cuesta corte" responde ✅ |
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

**Bloqueo (corregido)**: ~~P3~~. Investigación durante H6.0 confirmó que Guacuco
ya expone `validate_reschedule_slot` (tool handler invocado via
`POST /api/v1/tools/execute`) que deriva staff+services del `appointment_uuid`.
La spec P3 quedó **descartada** — proponía infraestructura `/tools/validate`
genérica que NUNCA existió en Guacuco.

**Hallazgo lateral resuelto**: el subgrafo H4 (schedule) apuntaba al mismo
endpoint fantasma `/tools/validate`. Refactorizado en H6.0 para usar
`check_availability` (Mode A) — único path real en Guacuco. Tests + tipos
actualizados.

**Objetivo**: validar que `schedule` y `reschedule` comparten ~80% del grafo.

**Entregables**:
- `src/graph/subgraphs/reschedule/` con state + reducer + 8 nodos
  (bootstrap, askSlot, validate, present, buildConfirm, gate, commit, success).
- State con 3 slots: `appointmentUuid`, `newDate`, `newTime`. Sin staff/services.
- `validate_availability` llama legacy `validate_reschedule_slot` con
  `{appointment_uuid, profile_uuid, date_hint, time_hint}`. Guacuco deriva
  staff/services + excluye el slot propio del cálculo.
- Bootstrap: 0 upcomings → response amable; 1 → pre-fill apt; 2+ → ask cuál.

**DoD**: 7 E2E tests críticos en `tests/unit/graph/subgraphs/reschedule.e2e.test.ts`
(0 upcomings, 1 upcoming exact, N upcomings, present_options, race recovery,
gate cancel, APPOINTMENT_NOT_FOUND). 47 tests reschedule + 7 E2E = 54 nuevos.
Total suite: 451 verdes.

---

## Hito 7 — Subgrafo `query` (intents fijos)

**Scope final (corregido 2 veces)**: 4 intents fijos + freeform_sql + cannot_answer.

**Iter 1 (H7.1-H7.4)**: scope-out freeform por error de mi parte. Asumí que la
infra Guacuco no existía sin verificar IDP_OV1.

**Iter 2 (H7.5)**: usuario apuntó al port existente en IDP_OV1
(`QueryEngine + SqlValidator + QuerySchemaResolver + QueryResultTruncator + QueryResultFormatter`).
Confirmado que Guacuco SÍ expone `/api/v1/query-processor/{tables,tables/:name/schema,query}`.
Freeform_sql implementado portando IDP_OV1 sin QueryJudge ni drill-down retry (iter 2 futuro).

**Intents implementados**:
- `service_prices` — lookup `state.catalog.services[].price`. Sin call extra.
- `service_list` — lookup catalog. Sin call extra.
- `my_upcoming` — lookup `state.crmContext.upcomingAppointments`. Sin call extra.
- `staff_schedule_day` — call `executeTool('get_staff_appointments_summary', ...)`.
  Role-aware: solo staff; client → cannot_answer en classifier.
- `freeform_sql` (H7.5) — text-to-SQL completo. LLM Haiku genera SQL contra
  schema dinámico cargado de Guacuco. 5 capas de validación local + Guacuco
  enforces server-side. 1 retry on execute error con contexto del error.
  Truncación de resultados antes de sintetizar. Fallback determinístico
  `formatRowsAsDetails` cuando LLM falla. Schema cache 1h por (profileType:roleId).
- `cannot_answer` — preguntas off-topic o no encajan, respuesta amable LLM Haiku.

**Out of scope v1** (registrado en [`docs/PENDING_ITER2.md`](./PENDING_ITER2.md)):
QueryJudge, drill-down retry, anáforas con historial, `business_hours` tool
dedicada, cache Redis multi-instancia. Cada uno con razón concreta y trigger
para reabrir.

**Entregables**:
- `src/graph/subgraphs/query/` con state + reducer + 3 nodos
  (classify_query Haiku, fetch_intent dispatch, synthesize_response Haiku).
- `GuacucoClient.getStaffAppointmentsSummary(params, {profileUuid, businessUuid})`.
- Tipos: `QueryDraftState`, `QueryIntent`, `GetStaffAppointmentsSummaryResult`.
- Defensa-en-profundidad: classifier rebaja staff_schedule_day a cannot_answer
  si rol=client; fetch_intent valida idem.
- **H7.5 freeform_sql**: `GuacucoClient.{getQueryTables, getQueryTableSchema, executeQuery}`
  + tipos `QueryProcessor{Tables,Schema,Execute}Response`. Helpers en
  `src/graph/subgraphs/query/`: `sqlValidator.ts` (5 capas), `schemaResolver.ts`
  (4 schemas por rol), `resultTruncator.ts` (cap 50k chars), `resultFormatter.ts`
  (fallback determinístico). Prompt `prompts/querySql.ts` (port simplificado
  IDP_OV1 sin drill-down/anáforas).

**DoD**: 10 E2E tests verdes en `tests/unit/graph/subgraphs/query.e2e.test.ts`
(intents fijos + 4 nuevos para freeform_sql: happy staff, DROP unsafe, client
schema, execute retry-and-fail). 82 tests unit del subgrafo query (state +
classify + fetch + synthesize + helpers + freeform). Total suite: 544 verdes.

---

## Hito 8 — Persistencia turnos + cutover

**Bloqueo**: P2 (endpoint persistir turnos) desplegado en Guacuco.

**Objetivo**: producción.

### H8.1 — Persistencia fire-and-forget ✅

- `GuacucoClient.persistAgentTurns(payload)` → `POST /api/v1/conversations/agent-turns`
  (response `{turn_id, persisted}`; idempotente server-side por `(thread_id, turn_id, role)`).
- `ConversationPersister` (`src/pregraph/`): build payload + swallow on throw + render
  no-text replies (cta/list/buttons) como texto plano para storage analítico.
- `maskPII` helper (`src/security/`): enmascara teléfonos (8-15 dígitos) y emails
  antes de persistir contenido user+assistant.
- Pipeline step 9 (`pregraph/pipeline.ts`): `void persister.persistTurn(...)` después
  del dispatch en welcome / rate_limited / graph paths. Cubre `subgraph` metadata
  desde `graphResult.routing?.activeSubgraph`. Silent skip y duplicate NO persisten
  (no hay identity completa).
- 25 tests nuevos (6 maskPII + 9 ConversationPersister + 3 GuacucoClient + 7 pipeline).
  Total suite: **569 verdes** (vs 544 al cierre de H7).

**`tool_calls[]` ✅ (instrumentado 2026-05-28)**: los commits de los 4 subgrafos
write registran la tool ejecutada (`ToolCallRecord {toolName, input, resultStatus,
errorCode?}`) acumulada en `subgraphState.meta.toolCalls`; el `subgraphFinalize`
la propaga al `outcome`, el pipeline la pasa al `ConversationPersister`, que la
mapea al shape Guacuco (`tool_name/input/result_status/error_code`). El subgrafo
`query` (read-only SQL) queda fuera por ahora — no muta el negocio.

### H8.2 — Métricas + Sentry Performance ✅

- `src/infrastructure/observability/metrics.ts`: registry prom-client con 5 counters
  + 1 histogram, todos prefijados `isladeplata_*`:
  - `turn_processed_total{channel, outcome_action}`
  - `rate_limit_hit_total{channel}`
  - `identity_not_found_total{channel}`
  - `subgraph_entered_total{subgraph}` (incluye `welcome` para new staff)
  - `persist_turn_total{result=ok|error}`
  - `pipeline_latency_ms{outcome_action}` (histogram con buckets 50-20000ms)
  - `resetMetrics()` helper para tests; NO uso productivo.
- Endpoint `GET /metrics` (`src/infrastructure/http/metricsHandler.ts`) gated por
  header `X-Metrics-Key` (env `METRICS_API_KEY`). Vacío → endpoint no se monta;
  presente → 401 sin header o key incorrecta, 200 con key correcta. 404 defensivo
  si el handler se monta con key vacía.
- Pipeline instrumentado: counters en cada exit path, histograma observado al
  cerrar `process()`. Sentry.startSpan envuelve `pipeline.process` (top) y
  `pipeline.graph.invoke` (sub-span) con atributos `isladeplata.*`.
- ConversationPersister con try/catch explícito + counter ok/error (reemplazó
  swallowAsync — ahora el error queda contabilizado además de logueado).
- 21 tests nuevos (8 metrics module + 4 endpoint + 7 pipeline + 2 persister).
  Total suite: **590 verdes** (vs 569 al cierre de H8.1).

### H8.3 — Cutover docs ✅ (scope reducido)

Decisión usuario: **cutover directo sin rollout gradual** — todos los negocios
van a isladeplata desde el día 1. Esto elimina la necesidad de routing dual
(router slim, mapping phone_number_id → backend, allowlist por business). El
rollback queda a nivel global vía revertir la callback URL de Meta a IDP v2.

Entregable: [`docs/RUNBOOK_CUTOVER.md`](./RUNBOOK_CUTOVER.md) con:

1. Pre-deploy checklist (repos, infra, env vars críticos H8 incluyendo
   `LANGSMITH_HIDE_INPUTS/OUTPUTS=true` en prod, observability).
2. Deploy + smoke test técnico (health, /metrics, webhook verify endpoint).
3. Flip del webhook en Meta Business Manager (paso a paso, define el "punto
   de no-retorno").
4. Post-deploy verification (4 mensajes de smoke + baseline de métricas +
   Sentry filter).
5. Rollback procedure con análisis de impacto (qué se pierde de negocio vs UX).
6. Triage table de incidentes (síntoma → dónde mirar → hipótesis comunes).
7. Cleanup post-cutover (apagar IDP v2 a las 2 semanas estables).

Algunos puntos del plan H8 original quedaron obsoletos por la decisión:
- §3.1 routing dual (no aplica, sin router)
- §3.2 rollout gradual fases 1→5→20→all (no aplica, full desde día 1)
- §4 comparativa side-by-side con IDP v2 (no aplica como pipeline online;
  el `messages` table de Guacuco P2 alimenta el post-mortem si hay incidente)

### Resto del hito

- **H8.4** — Cutover real + observación primeras 24h. Disparado por el primer
  mensaje productivo que pase por isladeplata. No codeable.
- **H8.5** — Cleanup (apagar IDP v2, archivar repo) a las 2+ semanas estables.

**DoD original**: paridad funcional en piloto. Con el scope ajustado, DoD
efectivo del hito completo H8 = isladeplata corriendo en producción >= 1 semana
sin error rate sostenido > 5% ni latencia p95 > 5s.

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
