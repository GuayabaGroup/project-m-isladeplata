# Plan H9 — Contenido de negocio (políticas + comercial/onboarding de plataforma)

> Pull-forward de [`docs/PENDING_ITER2.md`](PENDING_ITER2.md): port del manejador de IDP_OV1 que respondía políticas del negocio, temas comerciales y onboarding. En IDP eran 3 bloques de contexto autoritativo inyectados a un **único** prompt (`ToolUseEngine` clasificaba+respondía en una call). Acá clasificar y responder están **separados** (Haiku classify → nodo de respuesta), lo que cambia *dónde* viven los bloques y *cómo* se evita el redirect genérico.
>
> Feature 100% isladeplata-side. **No requiere endpoint nuevo en Guacuco**: el dato de Nivel A (`general_comments`) ya llega en `business_staff_roles`; la escalación de Nivel B reusa el takeover ya specd en [`docs/specs/P-human-takeover.md`](specs/P-human-takeover.md).
>
> Pre-requisitos: H7 (subgrafo `query`) ✅. No comparte código con H8.

---

## 0. Contexto

Hay **dos niveles de dominio** distintos, con autor de contenido distinto (ver memoria `reference-idp-business-content-two-levels`):

- **Nivel A — el negocio atiende a sus clientes finales.** Políticas operativas del negocio (medios de pago, cancelaciones, requisitos de confirmación). Autor = el **negocio**, vía columna SQL `businesses.general_comments`. Audiencia primaria = cliente final, pero **se inyecta a client y staff** (decisión usuario — paridad con IDP: si un staff pregunta algo gobernado por una política, también la usa).
- **Nivel B — la plataforma (Allia/Groomia/Divapp) atiende a los negocios.** Info comercial (precios, planes, "¿qué es Groomia?") y de onboarding (cómo configurar/operar). Autor = la **plataforma**, vía markdown versionado por `platformId`. Audiencia = **solo staff**.

Estado del contenido (2026-05-29): los `.md` de Nivel B arrancan **vacíos** (placeholders). El usuario confirmó que se escribirán pronto → se construye el mecanismo completo ahora, con **escalación determinista** mientras no haya contenido (nunca se deja inventar al LLM).

### El mismatch arquitectónico que define el diseño

En IDP, la política podía **redefinir el scope inline** (override de `out_of_scope`) porque clasificar+responder era una sola call. En isladeplata `classifyIntent` (Haiku) decide `messageType` y *otro* nodo redacta. No se puede "inyectar y pisar el OOS" en un paso. Anclas que se aprovechan:

- **`buildPersona`** (`config/personality/buildPersona.ts`) se antepone a **todos** los nodos que generan prosa (social, query-synth, confirm, success) → lugar natural para Nivel A.
- **El subgrafo `query`** ya tiene clasificador **role-aware** (prompts separados client/staff) + fetch + synthesize → forma natural para Nivel B (mismo shape: clasificar → traer contenido autoritativo → sintetizar).

---

## 1. Decisiones tomadas (congeladas)

| # | Decisión | Valor |
|---|---|---|
| D1 | Hogar de Nivel B | **Extender el subgrafo `query`** (2 intents staff-only). No subgrafo nuevo, no messageType nuevo. |
| D2 | Comportamiento Nivel B sin contenido | **Escalar a humano** (takeover IDP-style) + mensaje canned de respaldo. |
| D3 | Audiencia Nivel A | **client y staff** (paridad IDP). |
| D4 | `reasonCode` del takeover de Nivel B | `'other'` (único que encaja hoy). Evaluar agregar `'platform_question_no_content'` al enum si se quiere métrica dedicada. |
| D5 | `business_summary` | **Fuera de scope** por ahora; solo `general_comments` entra a la persona. |

---

## 2. Constraint crítico: la escalación depende de `HUMAN_TAKEOVER_ENABLED`

El takeover (`outcome.takeover` → `TakeoverNotifier.trigger` → `guacuco.triggerTakeover`) está **enteramente gated** detrás de `env.HUMAN_TAKEOVER_ENABLED` (`pregraph/pipeline.ts:363`), feature **parcialmente bloqueada hoy** (ver P-human-takeover). Si Nivel B emitiera *solo* la señal `takeover` y la env estuviera apagada, **no escalaría nada y el bot quedaría mudo**.

**Diseño robusto a ambos estados** — cuando el markdown está vacío, el nodo `fetchIntent` emite un `terminalOutcome`:

```ts
{
  action: 'handed_off',
  pendingReply: { text: '<canned: te derivo con el equipo de soporte de la plataforma>' },
  takeover: { reasonCode: 'other' },
}
```

- `HUMAN_TAKEOVER_ENABLED=true` → el pipeline lee `outcome.takeover` y dispara el notifier real (escalación IDP-style). El `pendingReply` también se envía.
- `HUMAN_TAKEOVER_ENABLED=false` → el bloque de takeover se saltea; el usuario igual recibe el `pendingReply` canned. Sin invención, sin mudez.

`finalize` ya propaga `terminalOutcome` (incluido `takeover`) al `outcome` global (`subgraphs/common/finalize.ts:47-52`), así que esto funciona **desde el subgrafo sin tocar el pipeline**.

---

## 3. Nivel A — políticas del negocio (client + staff)

### 3.1 Propagación del dato (ya existe en Guacuco)

`business_staff_roles.general_comments` (`clients/types/GuacucoTypes.ts:68`) llega en el identity resolve pero **no se mapea** al `Identity` interno.

| Archivo | Cambio |
|---|---|
| `core/types/Identity.ts` | `businessGeneralComments?: string \| null` con docstring (origen `businesses.general_comments`, editable vía SQL, autoritativo). |
| `pregraph/pipeline.ts` (`toInternalIdentityOrNull`, ~495) | Spread condicional: `...(identity.businessStaffRoles?.general_comments ? { businessGeneralComments: ... } : {})`. Patrón idéntico a `tenantName`/`agentName`. |

### 3.2 Inyección a la persona

| Archivo | Cambio |
|---|---|
| `config/personality/buildPersona.ts` | (a) `PersonaContext.businessPolicies?: string \| null`. (b) `toPersonaContext` lo deriva de `identity.businessGeneralComments`. (c) Nueva parte `<business_policies_and_notes>` (autoritativa, `escapeXml`, omitida si null/vacía). Va **después** de `BUSINESS IDENTITY` y **antes** del acento (que queda último por la regla de voseo/tuteo). |

Comentario del bloque (port literal de IDP, `SystemPromptBuilder.ts:144-150`): tratar como CONTEXTO AUTORITATIVO; si una política redefine el alcance (pagos, cancelaciones, confirmación), usarla **en vez** de marcar out-of-scope; alinear al usuario con la política, no rechazar el tema.

Como la persona se antepone a social-responder y query-synth, el bloque queda disponible en ambos **sin más cableado**.

### 3.3 La pieza que hace que la política redefina el scope

Por el mismatch (§0), el `classifyIntent` puede marcar una pregunta de política como `oos` → `socialResponder`, o el query-classifier como `cannot_answer`. En ambos casos el nodo **ya ve la persona con las políticas**; solo falta instruirlo a usarlas antes de declinar:

| Archivo | Cambio |
|---|---|
| `graph/supervisor/socialResponder.ts` (`TASK_BY_TYPE.oos`) | Añadir: *"Si el bloque `<business_policies_and_notes>` responde lo que pregunta el usuario, contestá desde ahí en lugar de redirigir."* |
| `graph/subgraphs/query/nodes/synthesizeResponse.ts` (`CANNOT_ANSWER_TASK`) | Mismo añadido. |

> **No se toca `classifyIntent`** para Nivel A: que clasifique `oos` es aceptable porque el responder responde igual desde la política.

---

## 4. Nivel B — comercial/onboarding (staff-only, reusa subgrafo `query`)

### 4.1 Content loader

| Archivo | Cambio |
|---|---|
| `infrastructure/content/PlatformContentLoader.ts` (nuevo) | Port de los loaders IDP (`PlatformCommercialContentLoader` + `PlatformOnboardingContentLoader`, unificados). Cache en memoria `Map<string, string>` con clave `"${kind}:${platformId}"`. `load(baseDir)` se llama UNA vez en bootstrap; sin TTL ni hot-reload (cambios → reiniciar). `get(kind, platformId): string \| undefined`. Loguea `count`/keys cargadas. |
| `content/commercial/{allia,groomia,divapp}.md`, `content/onboarding/{allia,groomia,divapp}.md` (nuevos) | Scaffolding con placeholders (estructura: ¿qué es?, planes/precios, features, para quién, contacto, FAQ — onboarding: primeros pasos, subir servicios/staff, conectar WhatsApp, horarios, compartir URL, cómo agendan los clientes). |
| `config/env.ts` + `tests/setup.ts` + `.env.example` | `CONTENT_DIR` (default `./content`) para el baseDir. Convención §CLAUDE.md: las 3 ubicaciones. |
| `main/bootstrap.ts` | Instanciar el loader, `await loader.load(env.CONTENT_DIR)` antes de compilar el grafo, inyectarlo a `makeFetchIntentNode`. |

### 4.2 Intents nuevos en el subgrafo query

| Archivo | Cambio |
|---|---|
| `graph/subgraphs/query/state.ts` | `QueryIntent += 'platform_commercial' \| 'platform_onboarding'`. |
| `query/nodes/classifyQuery.ts` | Sumar los 2 intents a `SYSTEM_PROMPT_STAFF` y a `VALID_INTENTS`. El prompt **client NO los menciona**. `normalize()` los rebaja a `cannot_answer` si `profileType !== 'staff'` (defensa en profundidad, igual que `staff_schedule_day` en `classifyQuery.ts:119`). |
| `query/nodes/fetchIntent.ts` | 2 `case` nuevos. Leen `loader.get(kind, identity.platformId)`. **Con contenido** → `{ rawResult: { kind, content }, phase: 'synthesizing' }`. **Sin contenido** → `{ phase: 'failed', terminalOutcome: <handoff+takeover, §2> }`. |
| `query/nodes/synthesizeResponse.ts` | Branch para estos intents: instrucción "respondé desde el contenido oficial provisto; si no cubre lo preguntado, decilo y derivá; **NO inventes pasos, menús, botones, precios ni URLs**" (port de los comentarios IDP `SystemPromptBuilder.ts:231-261`). |

### 4.3 Ruteo top-level (necesario para que lleguen al subgrafo)

El subgrafo `query` solo se entra si `classifyIntent` marca `messageType='query'`. Preguntas de setup ("¿cómo configuro mis horarios?") hoy podrían caer en `action`/`oos`.

| Archivo | Cambio |
|---|---|
| `graph/supervisor/classifyIntent.ts` | Hacer el prompt **role-aware**: cuando `state.identity?.profileType === 'staff'`, anexar líneas que ruteen preguntas sobre el **producto/plataforma** y su **configuración** a `query`. El nodo ya recibe `GraphState` → lee `state.identity`. Mismo patrón de prompt-por-rol que ya usa `classifyQuery`. |

---

## 5. Plan de implementación (sub-hitos)

### H9.1 — Nivel A (políticas)
Independiente, dato ya disponible, bajo riesgo, valor inmediato. Mergeable solo.
- Identity + pipeline mapping → persona block → ajuste de tasks oos/cannot_answer.
- Tests §6.1. **DoD**: una pregunta de política que el classifier marca `oos` se responde desde el bloque; sin políticas el bloque se omite; staff y client ambos lo reciben.

### H9.2 — Nivel B (comercial/onboarding)
- Loader + scaffolding markdown + env + bootstrap wire.
- Intents en state/classify/fetch/synth + role-awareness del classifier top-level.
- Escalación §2 robusta a `HUMAN_TAKEOVER_ENABLED` on/off.
- Tests §6.2. **DoD**: staff con contenido → respuesta desde markdown; staff sin contenido → handed_off + canned (+ takeover si env on); client nunca accede a estos intents; anti-alucinación verificada.

---

## 6. Tests críticos (vitest, `tests/unit` + `tests/integration`)

### 6.1 Nivel A
- `buildPersona` incluye `<business_policies_and_notes>` cuando hay comments; lo omite cuando null/vacío/whitespace.
- Escapado XML de `<`/`>`/`&` en el contenido de políticas.
- `toInternalIdentityOrNull` propaga `general_comments` y lo omite cuando ausente.
- E2E: input gobernado por política, classifier → `oos`, respuesta **usa** la política (no redirect genérico).

### 6.2 Nivel B
- `PlatformContentLoader`: carga 6 archivos; archivo ausente/vacío → `get` retorna undefined; log de count.
- `classifyQuery` staff devuelve `platform_commercial`/`platform_onboarding`; client los rebaja a `cannot_answer`.
- `fetchIntent` con contenido → `rawResult` + synthesizing; **sin contenido → `phase:'failed'` + `terminalOutcome.action='handed_off'` + `takeover.reasonCode`**.
- **Escalación con `HUMAN_TAKEOVER_ENABLED=true` Y `=false`**: ambos despachan el canned; solo el primero dispara el notifier.
- Anti-alucinación: con markdown que NO cubre la pregunta, la síntesis deriva en vez de inventar.
- `classifyIntent` role-aware: pregunta staff de setup → `query`; misma pregunta como client → no escala a intents de plataforma.

---

## 7. Riesgos

| Riesgo | Prob. | Mitigación |
|---|---|---|
| `classifyIntent` role-aware degrada la clasificación general | Media | Líneas staff se anexan solo cuando `profileType==='staff'`; tests de regresión del set client. |
| Reusar `query` mezcla "datos del negocio" con "producto plataforma" | Baja | Documentado; shape idéntico (classify→fetch→synth) y staff-gated. Si crece, extraer subgrafo `platform_info` después. |
| Escalación silenciosa si se asume takeover siempre activo | Media | §2 resuelve: canned de respaldo independiente de la env. Test explícito on/off. |
| El bloque de políticas infla tokens en cada turno | Baja | Solo si `general_comments` tiene contenido; es texto corto por negocio; se omite si vacío. |

---

## 8. Referencias

- IDP_OV1: `conversation/SupportHandler.ts`, `tooluse/SystemPromptBuilder.ts:139-264`, `infrastructure/content/Platform{Commercial,Onboarding}ContentLoader.ts`, `nlu/prompts/extraction.ts:81-82`, `ConversationProcessor.ts:733-788`.
- Memoria: `reference-idp-business-content-two-levels`.
- Specs relacionadas: [`P-human-takeover.md`](specs/P-human-takeover.md) (mecanismo de escalación), [`P-escalation-handoff.md`](specs/P-escalation-handoff.md).
- REGLAS: §2 (dirección de dependencias — loaders en infraestructura), §9 (anti-alucinación), §10.3/§10.5 (gating por rol).

---

## 9. Cambios a este documento

Cada modificación de alcance/orden/DoD se refleja en este archivo dentro del mismo PR, con justificación. Decisiones congeladas al 2026-05-29.
