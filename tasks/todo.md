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

---

# Estandarización del envío de mensajes (outbound) IDP `--i` + Guacuco `--g` (2026-05-28)

**Requerimiento:** "debe existir una estandarización de envío de mensajes, distintos tipos de
mensajes, incluyendo templates, ya que --g consume --i para enviar mensajes de distintos tipos".

Contrato único: `POST /api/v1/outbound/messages` con `type` (text | template | interactive | media).
Guacuco migra sus 3 endpoints legacy (`send-template-message`, `send-text-message-staff/client`) a este.

## Part A — IDP (project-m-isladeplata)
- [x] A0. REGLAS_ISLADEPLATA.md §1/§2 — documentar nueva capa `outbound/`
- [x] A1. core/types/OutboundMessage.ts — DTO union + interface `OutboundSender`
- [x] A2. channels/whatsapp/types.ts — variantes outbound template + media
- [x] A3. channels/whatsapp/sender.ts — `send()` retorna message id + traduce error Meta→IdpError
- [x] A4. nlg/OutboundMessageBuilder.ts — DTO → WhatsAppOutboundMessage
- [x] A5. channels/whatsapp/outboundSchema.ts — Zod discriminated union (snake_case → DTO)
- [x] A6. outbound/OutboundMessageService.ts — orquestación (implementa OutboundSender)
- [x] A7. infrastructure/http/middleware/apiKeyAuth.ts — API key timing-safe
- [x] A8. channels/whatsapp/outboundHttpHandler.ts — handler + envelope (movido desde infra por §2)
- [x] A9. infrastructure/http/registerRoutes.ts — montar POST /api/v1/outbound/messages
- [x] A10. config/env.ts + tests/setup.ts + .env.example — IDP_API_KEY
- [x] A11. main/bootstrap.ts — wire builder + service + handler
- [x] A12. tests (Vitest) — builder, service, schema, sender, handler, apiKeyAuth

## Part B — Guacuco (project-m-guacuco)
- [x] B1. IdpMessagingClient.ts — repunta al endpoint unificado
- [x] B2. IslaDePlataMessagingService.ts — los 4 métodos → endpoint unificado
- [x] B3. tests (Jest) — IdpMessagingClient wire-format test nuevo

## Verificación + audit
- [x] IDP: pnpm typecheck ✅ · pnpm test 699/699 ✅ · pnpm lint ✅
- [x] Guacuco: npm run build ✅ · npx jest 397/397 ✅
- [x] Auditoría vs REGLAS_ISLADEPLATA + REGLAS_GUACUCO (ver Review)
- [ ] Preguntar por PR

---

# Estandarización de inbound (IDP `--i`) (2026-05-28)

**Requerimiento:** "ahora necesitamos estandarizar los inbound". Scope: representación
interna + normalización (sin endpoint nuevo), solo WhatsApp (preparar abstracción),
normalizar y transportar media, capturar payload + contextMessageId de template buttons.

- [x] I-A. REGLAS_ISLADEPLATA.md §1/§7.1/§8.2/§12.1/§12.3
- [x] I-B. core/enums/InboundContentType.ts + core/types/ChannelMessage.ts (contentType + media/location/templateButton)
- [x] I-C. channels/whatsapp/types.ts — media/location/context en WhatsAppInboundMessage
- [x] I-D. channels/whatsapp/normalizer.ts — todos los content types + template-button capture
- [x] I-E. graph/supervisor/unsupportedContent.ts + wire en compile.ts (fast-path canned reply, ruta a END)
- [x] I-F. channels/ChannelAdapter.ts (InboundChannelAdapter) + WhatsAppInboundAdapter.ts + registerRoutes + bootstrap
- [x] I-G. tests: ~18 fixtures migradas (contentType), normalizer (todos los tipos), unsupportedContent, adapter, compile (media short-circuit)
- [x] I-H. pnpm typecheck ✅ · pnpm test 710/710 ✅ · pnpm lint ✅

## Review inbound

**Implementado y verde.** `ChannelMessage` estandarizado con discriminador `contentType`
requerido (`InboundContentType`); el normalizer de WhatsApp cubre TODOS los tipos entrantes
(text/interactive/template_button/image/audio/video/document/location) en vez de dropear
media; template buttons capturan `contextMessageId` + `payload`; contenido no soportado
recibe respuesta canned sin LLM (fast-path del supervisor → END); `InboundChannelAdapter` +
registry hacen drop-in un canal futuro (el grafo no se toca). Decisión: interfaz plana +
tag (no union discriminada) por el blast radius de ~18 consumidores/fixtures.

### Audit Results (REGLAS_ISLADEPLATA.md)
- ✅ §2 Dirección de dependencias: nuevos archivos respetan capas — `outbound`/`graph`/
  `channels` → `core` (valor); `infrastructure/http registerRoutes` → `channels` SOLO por
  tipo (`import type`, mismo precedente que el webhook handler); `nlg`/`graph` → `channels/types`
  por tipo (precedente `ResponseBuilder`/`buttonShortcut`). Sin `import axios` fuera de infra.
- ✅ §4 ESM/`.js`/`import type`/zero `any` (biome verde).
- ✅ §8.2 `outcome` en fast-path del supervisor (documentado); §9-clean (sin LLM, sin datos críticos).
- ✅ §12.1/§12.3 estructura por canal + agnosticidad: grafo intacto; sumar canal = adapter + push al array.
- ✅ §12.4 `CHANNEL_FORMATS` reusado (no aplica truncado a media).
- ✅ §13.1 webhook sigue con `express.raw` por ruta (HMAC) dentro del adapter; sin `express.json` global.
- ✅ §14 tests Vitest fuera del source; cobertura por content type + fast-path + adapter.
- Sin dead code (factory de fixtures descartada al migrar inline).

## Review outbound

**Implementado y verde** en ambos sistemas. Estándar final:
- Contrato único `POST /api/v1/outbound/messages` con `type` discriminado
  (text | template | interactive | media). DTO agnóstico en `core/OutboundMessage.ts`.
- Nueva capa `outbound/` documentada en REGLAS §1/§2 (aprobada por owner).
- Resolución de canal por `(role, platformId)`; `user_type:owner→staff` colapsado en el schema.
- Idempotencia opcional vía `DedupStore` (reuso). Templates HSM con quick-reply buttons
  (componentes Meta exactos, `index` string). Media image/document.
- WhatsAppSender retorna el wamid y traduce errores Meta→`IdpError(whatsapp_send_failed)`
  con `details.meta` (sin importar axios fuera de infra).
- Guacuco: interfaces públicas intactas; solo cambió wire body/URL/parse. Fire-and-forget
  + `template_send_log` preservados.

### Audit Results
- ✅ §2 Dirección de dependencias: hallazgo en auto-audit → el handler estaba en
  `infrastructure/http` con value-import de `channels/` (PROHIBIDO). **Corregido**: handler
  movido a `channels/whatsapp/outboundHttpHandler.ts` (co-locado con webhook+schema); la
  extracción del error Meta se movió al sender (acceso estructural, sin `import axios`).
- ✅ §4 TS/ESM: imports `.js`, `import type`, zero `any`.
- ✅ §12 Canales + §12.4: builder reusa `CHANNEL_FORMATS`/`truncate`; params de template NO truncados.
- ✅ §13.1 Seguridad: `apiKeyAuth` con `timingSafeEqual` (no `===`); `IDP_API_KEY` min 16.
- ✅ §13.2 Errores: `IdpError` en todo el path (nunca `new Error`).
- ✅ Guacuco REGLAS §9/§11/§17: envelope `{success,data}`; fire-and-forget; AbortController; build ✅.
