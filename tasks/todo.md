# Tareas — Corrección A1, A2, A3 (Isladeplata)

> Fixes derivados del análisis de brechas 2026-05-28. Objetivo: que cancel/confirm/reschedule
> funcionen end-to-end y que el usuario pueda cambiar de intent mid-flow.

---

## A1 — Poblar `crmContext.upcomingAppointments` desde Guacuco identity `[CRÍTICO, bajo riesgo]`

Hoy `pipeline.ts:212` deja el CRM vacío cuando `PARGUITO_ENABLED=false` (default actual),
así que cancel/confirm/reschedule siempre ven 0 turnos. REGLAS §7.1 paso 7 exige augmentar
con `profileData.appointments` de Guacuco (que ya viene en identity resolve).

- [ ] `core/types/CrmContext.ts`: `startAt` → opcional (`startAt?: string`). Guacuco
      `profile_data.appointments` solo trae `{appointment_uuid, description}` (sin fecha).
- [ ] `pregraph/pipeline.ts`: nuevo helper `crmContextFromIdentity(base, identity)` que mapea
      `identity.profileData.appointments` → `upcomingAppointments` (Guacuco es la fuente de
      verdad de turnos). `profileMeta` se mantiene de Parguito (o `{}`).
- [ ] Wire en step 6: `const crmBase = PARGUITO_ENABLED ? await parguito... : EMPTY_CRM_CONTEXT;`
      `const crmContext = crmContextFromIdentity(crmBase, identity);`
- [ ] Verificar que ningún consumidor asuma `startAt` presente (askSlot ya usa `u.startAt ?`).
- [ ] Tests: unit del helper + pipeline (identity con appointments → crmContext poblado).

## A3 — Resolución texto libre → appointmentUuid en cancel/confirm/reschedule `[ALTO, bajo riesgo]`

Hoy solo `schedule` tiene `resolveEntities`. En los otros 3, texto libre queda `status:'guessed'`
y nunca se resuelve → loop hasta `handed_off` salvo que el usuario tappee el botón de la lista.

- [ ] Helper puro compartido `graph/subgraphs/common/matchAppointment.ts`:
      `matchAppointmentByPhrase(phrase, candidates): UpcomingAppointment | null` (normalize +
      exact/substring sobre `description`; null si 0 o múltiples ambiguos). Mismo patrón que
      `findServiceByName` en schedule/resolveEntities.
- [ ] `cancel/nodes/askSlot.ts` interpretReply: rama texto libre → intentar match; si único →
      `status:'resolved'` + `phase:'awaiting_confirmation'`; si no → `guessed` (como hoy).
- [ ] `confirm/nodes/askSlot.ts` interpretReply: igual → si match `phase:'committing'`.
- [ ] `reschedule/nodes/askSlot.ts` interpretReply (rama `appointmentUuid`): igual → resolved.
- [ ] Tests: match único, 0 match, múltiples ambiguos, accent-insensitive, por subgrafo.

## A2 — Abdicación de intent mid-flow (supervisor §10.2) `[ALTO, riesgo medio — TIER-1]`

El `Command(resume)` salta al nodo interrumpido; el supervisor no corre en resume. La
abdicación se implementa como **gate pre-grafo** antes de decidir resume vs fresh.

- [ ] `pregraph/AbdicationDetector.ts`: `detect(text, activeSubgraph): Promise<{abdicate, newIntent?}>`.
      LLM Haiku (SUPERVISOR_CONFIG) con prompt enfocado ("el usuario está en medio de {flow};
      ¿este mensaje responde a la pregunta o es un pedido nuevo?"). **Fail-closed**: parse fail o
      baja confianza → `abdicate:false` (reanuda — default seguro, no se pierde el draft por error).
      Solo se invoca con texto libre (los button payloads SIEMPRE reanudan, nunca abdican).
- [ ] `infrastructure/checkpointer/PostgresCheckpointerService.ts`: `deleteThread(threadId)`
      (reusa el DELETE del cleanup para un solo thread). Expuesto vía `ThreadResolver.discardThread`.
- [ ] `pregraph/pipeline.ts` step 7.1: si `pendingInterrupts && !buttonPayload`:
      - `detect()`. Si `abdicate` → `discardThread(threadId)` + invoke FRESH (supervisor reclasifica
        y rutea al subgrafo nuevo). Si no → `Command(resume)` como hoy.
      - Métrica `subgraph_abdicated_total{from,to}` (nueva en metrics.ts).
- [ ] `main/bootstrap.ts`: wire `AbdicationDetector` (recibe `llm`) en deps del pipeline.
- [ ] `config/env.ts` + `tests/setup.ts` + `.env`: (si hace falta threshold/flag) — evaluar.
- [ ] Tests: detector (abdica / reanuda / fail-closed); pipeline (texto nuevo intent → fresh;
      button → resume; ambiguo → resume).

### Decisión de producto pendiente (A2)
Al abdicar: ¿se **descarta** el draft en curso (UX simple, el usuario claramente cambió de tema)
o se **preserva** para ofrecer retomarlo después? Default propuesto: descartar.

---

## Orden de ejecución
1. A1 (desbloquea los 3 subgrafos) → typecheck + test
2. A3 (resolución texto libre) → typecheck + test
3. A2 (abdicación, TIER-1) → typecheck + test
4. Auditoría post-implementación contra REGLAS_ISLADEPLATA.md

## Review
_(a completar al cerrar)_

---

# Estandarización del consumo de tools IDP → Guacuco (2026-05-28)

**Flag:** `--i`. Cero cambios de código en Guacuco (la convergencia es aditiva y verificada segura contra `ToolMapper`).
**Requerimiento:** "debe existir una estandarización de consumo de tools desde --i hacia --g".

## Diagnóstico (confirmado contra código real)

`POST /api/v1/tools/execute` lleva un `context` que es el **sobre de identidad crítico** del guard cross-business (§9, §13.1). Hoy NO hay estándar:

1. `context` es `Record<string, unknown>` (sin tipo) → un typo desactiva el guard en silencio. (`GuacucoClient.ts:44`, `GuacucoTypes.ts:118`)
2. Dos identificadores de negocio sin regla: `business_allia_id` vs `business_uuid`.
3. El mapeo `Identity → context` está duplicado en 3 capas / 9 formas (cliente, commit nodes, atomic tools).
4. La identidad va en `parameters` para schedule y en `context` para el resto.
5. Las 4 atomic tools llaman `executeTool('magic_string', …)` directo desde `graph/` (smell de capas §2).
6. `ExecuteOptions` tiene forma distinta por método.

### Hallazgo grave: 4 tools rotas hoy
- `generate_verification_url`: falta `parameters.profile_uuid` (lo manda en context, donde Guacuco no lo lee).
- `connect_mercado_pago`: falta `parameters.profile_uuid` (manda `business_allia_id` en context, descartado).
- `retrieve_manzanillo_url`: falta `parameters.business_allia_id`.
- `forward_message`: **no existe handler en Guacuco** (grep en todo `guacuco/src`).

## Contrato canónico verificado (Guacuco `ToolMapper.ts:9-26`)
- Context keys que Guacuco lee: `profile_uuid, profile_type, business_uuid, role_id`.
- `business_allia_id` **NO** es key de context → va en `parameters`.
- Extra keys: ignorados (sin validación strict). Convergencia = segura/aditiva.

## El estándar

Un único `ToolContext` tipado, derivado de `Identity` en UN lugar, enviado en TODA tool. Ningún nodo `graph/` arma dicts de context ni conoce tool-name strings.

- [x] **T1** `ToolContext` tipado en `clients/types/GuacucoTypes.ts`: `{ profile_uuid; profile_type; business_uuid; role_id? }`.
- [x] **T2** Builder único `clients/mappers/ToolContextMapper.ts → toolContextFromIdentity(identity)`.
- [x] **T3** Registro `GUACUCO_TOOLS = {…} as const` en `core/enums/GuacucoToolName.ts` (movido a `core/` por §2 — ver Audit); reemplaza string literals en client + `TOOL_NAME` de commit nodes.
- [x] **T4** Retipado `ExecuteOptions.context` y `ToolExecuteRequest.context` → `ToolContext`.
- [x] **T5** `executeTool` → `protected` (solo dispatch interno).
- [x] **T6** Métodos tipados uniformes `(params, identity, opts?)`: schedule, cancel, reschedule, confirm, check_availability, validate_reschedule_slot, get_staff_appointments_summary, resolve_client.
- [x] **T7** Métodos tipados para las 4 atomic tools + fix de placement (las 3 rotas arregladas):
  - `retrieveManzanilloUrl(identity)` → `params {business_allia_id}` + context uniforme.
  - `generateVerificationUrl(identity)` → `params {profile_uuid}` + context uniforme.
  - `connectMercadoPago(identity)` → `params {profile_uuid}` + context uniforme.
  - `forwardMessage(text, identity)` → estandarizado pero FLAG: sin handler en Guacuco → req `--g` creado en `second-brain/.../guacuco-forward-message-tool-handler.md`.
- [x] **T8** Call sites actualizados: 4 commit nodes, 2 validateAvailability, resolveEntities, query fetchIntent, 4 atomic tools.
- [x] **T9** Tests: `ToolContextMapper.test.ts` nuevo + 18 test files actualizados.
- [x] **T10** `pnpm typecheck` ✅ · `pnpm test` 667/667 ✅ · `pnpm lint` ✅.
- [x] **T11** Auditoría post-implementación (ver abajo).

## Review estandarización

Implementado y verde (typecheck + 667 tests + lint). Estándar final:
- **Context uniforme tipado** (`ToolContext`) derivado de `Identity` en UN solo lugar (`toolContextFromIdentity`), enviado en toda tool.
- **Registro único** de tool names (`GUACUCO_TOOLS` en `core/`).
- **`executeTool` protected**: ningún nodo del grafo arma context ni conoce wire strings.
- **Bug fix**: las 4 atomic tools estaban rotas (placement de params/context). 3 arregladas; `forward_message` flaggeada (req `--g`).

### Audit Results (REGLAS_ISLADEPLATA.md)
- ✅ §2 Dirección de dependencias: hallazgo durante audit → `GUACUCO_TOOLS` se importaba como *valor* runtime de `clients/` hacia `graph/` (solo permitido por tipo). **Corregido**: movido a `core/enums/GuacucoToolName.ts` (runtime-importable por todas las capas). `clients/`→`core/` y `graph/`→`core/` ✅.
- ✅ §4 TS/ESM: imports `.js`, `import type`, zero `any` (context tipado; `forwardMessage` retorna `unknown`).
- ✅ §6 HTTP clients: todo por `RetryClient`/`unwrap`; sin axios directo; sin nuevos clients (no hay herencia nueva).
- ✅ §9 Anti-alucinación: context derivado SOLO de `state.identity`, nunca del LLM — ahora con fuente única (refuerza §9.1).
- ✅ §13 Errores: sin cambios; `ToolExecutionError` vía `unwrap`.
- ✅ §15 Naming/un-componente-por-archivo: `GuacucoToolName.ts`, `ToolContextMapper.ts`, `UPPER_SNAKE`, `camelCase`.
- Sin dead code (interfaces locales `*UrlResult` removidas de las atomic tools); sin secretos hardcodeados.
