# Reglas de Isladeplata

> Documento canónico de reglas, arquitectura y convenciones del agente conversacional **Isladeplata** — sucesor del IDP v2, construido con **LangGraph + TypeScript**. Todo código, refactoring o feature nuevo **DEBE** cumplir estas reglas. Violar una regla requiere justificación explícita y aprobación del owner.
>
> **Filosofía de destilación**: Isladeplata reemplaza la capa conversacional de IDP v2 (slot-tracking custom, post-validador, watchers) con primitivas nativas de LangGraph (channels, reducers, interrupts, checkpointer). Hereda contrato/dominio del IDP v2 + Guacuco, descarta la implementación que LangGraph reemplaza nativamente. Para auditorías cruzadas ver también `project-m-idp_OV1/docs/REGLAS_IDP.md` y `project-m-guacuco/docs/REGLAS_GUACUCO.md`.

---

## Tabla de Contenido

1. [Arquitectura — Capas bajo `src/`](#1-arquitectura--capas-bajo-src)
2. [Dirección de Dependencias](#2-dirección-de-dependencias)
3. [Composition Root + Bootstrap Order](#3-composition-root--bootstrap-order)
4. [TypeScript + ESM (NodeNext)](#4-typescript--esm-nodenext)
5. [Sin acceso directo a Postgres del negocio](#5-sin-acceso-directo-a-postgres-del-negocio)
6. [HTTP Clients (Guacuco / Parguito)](#6-http-clients-guacuco--parguito)
7. [Capa pre-grafo (webhook → invoke)](#7-capa-pre-grafo-webhook--invoke)
8. [Estado del grafo (`GraphState`)](#8-estado-del-grafo-graphstate)
9. [Anti-alucinación: state como única fuente de verdad](#9-anti-alucinación-state-como-única-fuente-de-verdad)
10. [Supervisor + Subgrafos](#10-supervisor--subgrafos)
11. [LLM (provider-agnóstico, modelos por nodo)](#11-llm-provider-agnóstico-modelos-por-nodo)
12. [Canales (WhatsApp dual + agnosticidad)](#12-canales-whatsapp-dual--agnosticidad)
13. [Seguridad + Errores + Logging](#13-seguridad--errores--logging)
14. [Testing (Vitest)](#14-testing-vitest)
15. [Convenciones generales](#15-convenciones-generales)
16. [Checklist: NUNCA / SIEMPRE](#16-checklist-nunca--siempre)

---

## 1. Arquitectura — Capas bajo `src/`

```
src/
├── main/             # Bootstrap + composition root + lifecycle
│   ├── server.ts
│   ├── bootstrap.ts
│   └── shutdown.ts
│
├── config/           # env.ts (Zod fail-fast), channels.config.ts, llm.config.ts
│
├── infrastructure/   # Adaptadores externos
│   ├── http/             # Express app, RetryClient, middleware
│   ├── llm/              # LlmProvider interface + AnthropicProvider/OpenAIProvider + createLlmProvider
│   ├── checkpointer/     # Postgres checkpointer de LangGraph + TTL/cleanup
│   ├── redis/            # DedupStore, RateLimitStore (NO sesiones)
│   └── observability/    # Winston logger + Sentry + swallowAsync
│
├── channels/         # Canales de entrada/salida
│   ├── whatsapp/         # webhook + verify + normalizer + sender + types + WhatsAppInboundAdapter
│   ├── ChannelAdapter.ts # contratos comunes: MessageProcessor + InboundChannelAdapter (registry)
│   └── (telegram/, mobile/, web/ — se agregan después sin tocar el grafo)
│
├── clients/          # HTTP clients hacia backends propios
│   ├── BaseHttpClient.ts # retry + envelope unwrap + errores tipados
│   ├── GuacucoClient.ts  # turnos, identity, tools/execute, tools/validate
│   └── ParguitoClient.ts # CRM context (stub Etapa 3)
│
├── pregraph/         # Orquestador pre-grafo (NO es un LangGraph)
│   ├── pipeline.ts       # 10 pasos secuenciales (ver §7)
│   ├── ThreadResolver.ts # checkpoint lookup + TTL + Command(resume) builder
│   └── ResponseDispatcher.ts # outcome → ResponseBuilder → sender
│
├── graph/            # El grafo LangGraph y sus primitivas
│   ├── state.ts          # GraphState (channels + reducers)
│   ├── compile.ts        # construye el grafo compilado al boot
│   ├── supervisor/       # nodo clasificador + router
│   ├── subgraphs/
│   │   ├── schedule/     # state, nodes, interrupts, compile
│   │   ├── reschedule/
│   │   ├── cancel/
│   │   └── query/        # text-to-data via Guacuco
│   ├── tools/            # tool atómicas (system, support) compartidas
│   └── nodes/            # helpers reusables (resolve_entities, format_message…)
│
├── nlg/              # Formateo de respuesta por canal
│   ├── ResponseBuilder.ts        # OutboundReply (grafo) → payload, CHANNEL_FORMATS centralizado
│   └── OutboundMessageBuilder.ts # OutboundMessageDto (API) → payload de canal
│
├── outbound/         # Envío proactivo de mensajes (S2S: Guacuco → IDP → canal)
│   └── OutboundMessageService.ts # orquesta resolución de canal + dedup + sender (recibe sender por inyección)
│
├── security/         # HMAC, sanitización, guardrails
│
└── core/             # Tipos puros, enums, errores (NO depende de nada)
    ├── enums/        # ChannelType, InboundContentType, OutcomeAction, ...
    ├── errors/       # IdpError + subtipos (IdentityNotFound, ToolExecution, RateLimit)
    └── types/        # ChannelMessage (contentType+media+location+templateButton), Identity, CrmContext, Outcome, OutboundMessage
```

Cada capa tiene un rol claro. **No hay grises**.

---

## 2. Dirección de Dependencias

```
                          core
                            ▲
        ┌───────────────────┼───────────────────┐
        │                   │                   │
  infrastructure      pregraph + graph      security
        ▲                   ▲                   ▲
        │                   │                   │
        └─ channels / clients / nlg / outbound ─┘
                            ▲
                           main
```

### Reglas absolutas

| Capa | Puede importar de | NO puede importar de |
|------|-------------------|---------------------|
| `core/` | Solo sí misma. | TODO lo demás |
| `config/` | `core/` | `main/`, `pregraph/`, `graph/`, `channels/`, `clients/`, `infrastructure/` |
| `infrastructure/` | `core/`, `config/` | `main/`, `pregraph/`, `graph/`, `channels/`, `clients/`, `nlg/` |
| `clients/` | `core/`, `config/`, `infrastructure/http/`, `infrastructure/observability/` | `main/`, `pregraph/`, `graph/`, `channels/`, `nlg/` |
| `graph/` | `core/`, `config/`, `infrastructure/llm/`, `infrastructure/observability/`, `clients/` (por tipo), `security/` | `main/`, `channels/`, `pregraph/`, `nlg/` |
| `pregraph/` | `core/`, `config/`, `clients/`, `infrastructure/`, `security/`, `graph/` (solo `compile()` y tipos) | `main/`, `channels/` (recibe `ChannelAdapter` por inyección) |
| `nlg/` | `core/`, `config/` | TODO el resto |
| `outbound/` | `core/`, `config/`, `infrastructure/` (redis, observability), `nlg/` (por tipo) | `main/`, `graph/`, `pregraph/`, `clients/`, `channels/` (directo — recibe `WhatsAppSender` por inyección) |
| `channels/` | `core/`, `config/`, `security/`, `infrastructure/observability/`, `nlg/` (por tipo) | `main/`, `pregraph/`, `graph/`, `outbound/` |
| `main/` | TODAS | — |

### Violaciones prohibidas

- Importar `pg`, `kysely`, `prisma` o cualquier driver SQL del negocio desde cualquier capa de isladeplata (ver §5).
- Importar `@langchain/langgraph` desde `core/`, `clients/`, `channels/`, o `nlg/`. Solo `graph/`, `pregraph/`, e `infrastructure/checkpointer/` conocen LangGraph.
- Importar `@anthropic-ai/sdk` directo desde fuera de `infrastructure/llm/`.
- Importar `axios` directo desde fuera de `infrastructure/http/`.
- Importar entre canales hermanos (`whatsapp/` ↔ `telegram/`...) — usar `ChannelAdapter.ts` o `core/`.

---

## 3. Composition Root + Bootstrap Order

Isladeplata **no usa DI container**. El wiring vive en `src/main/bootstrap.ts` como composition root manual.

### Orden estricto

1. Validar env (al importar `env.ts`)
2. `initSentry`
3. `connectRedis` (dedup + rate limit únicamente)
4. `connectPostgresCheckpointer` (LangGraph)
5. `createLlmProvider(env, logger)` (Anthropic/OpenAI según `LLM_PROVIDER`)
6. HTTP clients (`GuacucoClient`, `ParguitoClient`)
7. Redis stores (`DedupStore`, `RateLimitStore`)
8. Compile del grafo (`compileGraph(checkpointer, llmProvider, clients)`) — **una sola vez**, los threads de cliente y staff comparten el grafo compilado.
9. `ThreadResolver` + `ResponseDispatcher`
10. `pregraph.pipeline` factory (recibe todo lo anterior por inyección)
11. Senders + `ResponseBuilder` + `ChannelAdapter` (`processMessage`)
12. Workers/jobs (cleanup de checkpoints expirados, trace flush si aplica)
13. `createApp()` + `/health` + `registerRoutes(app, processMessage)`
14. Retornar `{app, cleanup}`

### Reglas

1. Ningún componente conoce a los demás vía import directo — todos reciben sus deps por constructor.
2. **`logger` es la única excepción**: se importa de `infrastructure/observability/logger.ts` directo. NO se inyecta salvo donde facilite mocking.
3. **Cleanup order**: stop workers → flush checkpoints pendientes (si los hay) → close Sentry → quit Redis → close Postgres pool. Cada paso captura sus propios errores y **nunca bloquea el shutdown**. Usar `runCleanup(steps, logger)` (heredado del patrón de IDP v2).
4. Postgres del checkpointer se cierra **al final** — pasos previos pueden necesitarlo.

---

## 4. TypeScript + ESM (NodeNext)

### 4.1 — Strict mode

`tsconfig.json` con `"strict": true`. `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`. **No relajar.**

### 4.2 — Imports DEBEN llevar `.js`

```typescript
import { compileGraph } from './graph/compile.js'; // CORRECTO
```

ESM puro + NodeNext. **Sin excepciones**.

### 4.3 — Zero `any`

Prohibido. Usar `unknown` con narrowing, o Zod, o cast a shape conocido.

### 4.4 — `import type` cuando solo necesites el tipo

```typescript
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
```

### 4.5 — `as const` sobre Enums

```typescript
export const PROFILE_TYPES = ['client', 'staff'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];
```

### 4.6 — Interfaces para shapes, types para uniones

```typescript
export interface Identity { tenantUuid: string; profileType: ProfileType; /* ... */ }
type Outcome = 'response' | 'awaiting_user' | 'error' | 'ignored' | 'rate_limited' | 'handed_off';
```

### 4.7 — Reutilizar tipos existentes

Antes de crear un tipo, busca en `core/types/`, `core/enums/`, `clients/types/`, o el shape ya definido por el componente que lo expone.

---

## 5. Sin acceso directo a Postgres del negocio

**REGLA NO NEGOCIABLE**. Isladeplata **NUNCA** importa `pg`, `kysely`, `prisma`, ni se conecta a la BD del negocio.

- Toda lectura/escritura de datos de negocio (turnos, clientes, servicios, staff, plataformas) va por **Guacuco** o **Parguito** vía HTTP.
- Si necesitas un dato nuevo, **primero exponerlo como endpoint en Guacuco/Parguito**, después consumirlo desde isladeplata.

### Matiz importante: hay DOS Postgres conceptualmente distintos

| Postgres | Quién lo usa | Para qué | Acceso desde isladeplata |
|---|---|---|---|
| **Postgres del negocio** | Guacuco | turnos, clientes, servicios, staff | ❌ NUNCA directo |
| **Postgres del agente** | LangGraph checkpointer + jobs de cleanup | state conversacional, threads pausados, trazas opcionales | ✅ vía `infrastructure/checkpointer/` |

El driver `pg` (o equivalente) solo aparece en `infrastructure/checkpointer/`. Ningún componente de negocio importa `pg`.

---

## 6. HTTP Clients (Guacuco / Parguito)

### 6.1 — Toda llamada HTTP saliente va por `RetryClient`

`infrastructure/http/RetryClient.ts` envuelve `axios` con retry exponencial + jitter (max 2 reintentos), solo retrya 5xx + errores de red, NO retrya 4xx (incluido 404 y 401), backoff base 200ms capped en 2000ms.

### 6.2 — `BaseHttpClient` (única excepción canónica a herencia)

`clients/BaseHttpClient.ts` es **clase abstracta** que encapsula el patrón común. Provee:
- Constructor con `baseURL`, `apiKey`, `timeoutMs`, `logger` → instancia `RetryClient` con headers (`X-API-Key`, `Content-Type: application/json`).
- `protected unwrap<T>(response): T` — único punto donde se procesa el envelope `{success, data?, error?}` de Guacuco/Parguito:
  - `success: false` → `ToolExecutionError(code, message)`
  - envelope inválido → `ToolExecutionError('{prefix}_invalid_envelope', ...)`
  - `success: true` con `data` undefined → `ToolExecutionError('{prefix}_missing_data', ...)`
- `protected abstract readonly errorPrefix: string` — cada subclase declara su prefijo (`'guacuco'`, `'parguito'`).

**Reglas:**
1. Todo nuevo HTTP client hacia un backend propio **DEBE extender `BaseHttpClient`**.
2. NUNCA usar `axios` directo, ni instanciar `RetryClient` ad-hoc.
3. Los métodos públicos retornan `T` o lanzan excepción tipada. NUNCA exponer el envelope.
4. Excepciones de dominio: `IdentityNotFoundError`, `ToolExecutionError(code, message)`, `IdpError(code, message)`. NUNCA `new Error('...')`.
5. Timeouts y URLs siempre desde env vars. NUNCA hardcodear.

### 6.3 — Endpoints clave (snapshot al 2026-05-27)

| Endpoint | Uso |
|---|---|
| `POST /identity/resolve` (Guacuco) | resolver identity + business + catálogo de servicios/staffs en una call |
| `POST /api/v1/tools/execute` (Guacuco) | escribir (schedule, cancel, reschedule, confirm) |
| `POST /api/v1/tools/validate` (Guacuco) | validar slot exacto con suggestions cortas (3) |
| `POST /api/v1/tools/execute` (`check_availability`) | vista exploratoria de disponibilidad (10 slots en 14 días) |

Cuando se agregue idempotency key en writes (P1 del sprint), pasarlo como `idempotency_key` (UUID, candidato natural: `intent_uuid` del subgrafo).

---

## 7. Capa pre-grafo (webhook → invoke)

El pre-grafo es **código TS secuencial**, NO un LangGraph. Razón: los pasos que viven aquí son determinísticos, no se reanudan, y algunos abortan sin entrar al grafo. Meterlos como nodos del grafo agrega latencia (escritura al checkpointer) sin valor.

### 7.1 — Los 10 pasos (orden estricto)

1. **Verify signature** — HMAC WA / secret token TG vía `validateWebhookSignature` (timing-safe).
2. **Normalize** — payload externo → `ChannelMessage` (con `contentType` requerido; media/location se transportan, no se dropean). Por canal, vía el `InboundChannelAdapter` del canal.
3. **Dedup** — Redis `SET NX` con TTL 300s, key `dedup:{channel}:{messageId}`. Duplicate → 200 OK + log + return.
4. **Identity resolve** — Guacuco `POST /identity/resolve` con `(channelType, channelId, phoneNumberId)`. Output incluye business_allia_id, profileType, helpersLists (catálogo), welcomeMessage/onboardingUrl si `isNewUser`.
5. **Rate limit** — Redis incr+expire (20 msg/min default), TTL 60s, key derivada de identity. Throttled → respuesta corta determinística, NO entra al grafo.
6. **Thread management** — `thread_id = ${tenantUuid}:${profileUuid}:${channel}:${platformId}`. Lookup en checkpointer:
   - Si checkpoint `interrupted` y dentro de TTL → preparar `Command(resume=interpretedInput)`.
   - Si `completed`, no existe, o expirado → state inicial fresco.
7. **CRM context fetch** — Parguito (defaults si caído) + augment con `profileData.appointments` de Guacuco (ya viene en step 4). **Una sola vez por turno**.
8. **Build initial state + invoke/resume** del grafo compilado.
9. **Dispatch outcome** — `ResponseBuilder` formatea por canal, sender envía (sync para mobile, out-of-band para WA/TG).
10. **Side effects no críticos** vía `swallowAsync`: persistir turno a Guacuco (cuando P2 esté listo), signals a Parguito, trace, métrica.

### 7.2 — Welcome flow (refinado)

- **Staff sin business** → Guacuco auto-onboarda silenciosamente, response normal con `isNewUser=true`.
- **Cliente sin business** (`USER_NOT_FOUND`) → **silent skip**: no se responde. NO entra al grafo, NO se loguea como error.

### 7.3 — TTL del checkpoint

24h WhatsApp/Telegram, 4h mobile (heredado del IDP v2 §10.1). LangGraph no tiene TTL nativo del checkpointer → **verificación inline al lookup** (si `now - updated_at > TTL` → tratar como expirado) **+ job periódico** que borra checkpoints viejos para no inflar la tabla. Ambos.

### 7.4 — Webhook responde 200 SIEMPRE (excepto auth fail)

WA/TG webhooks responden 200 inmediato y procesan async. Auth fail → 401. **NUNCA** retornar 5xx por errores de procesamiento — Meta/Telegram reintentarían infinito.

---

## 8. Estado del grafo (`GraphState`)

### 8.1 — Estructura canónica

```
GraphState = {
  messages:       BaseMessage[]     // reducer LangGraph estándar (append + trim)
  input:          { channelMessage, receivedAt }
  identity:       Identity          // ver §12.2
  crmContext:     CrmContext
  routing:        { activeSubgraph?, handoff? }
  subgraphState?: unknown           // shape definido por cada subgrafo
  outcome?:       { action, pendingReply? }
}
```

### 8.2 — Dueños únicos de cada bloque (regla crítica heredada de IDP v2 §7.4)

| Campo | Único mutador | Notas |
|---|---|---|
| `messages` | reducer LangGraph (append + trim cap N) | Cap heredado de `MAX_RECENT_MESSAGES` |
| `input.*` | **inmutable** — solo lo escribe el adapter pre-grafo | El grafo no muta el input del turno |
| `identity.*` | **inmutable** — solo lo escribe el adapter pre-grafo | Cambio de identity = thread nuevo |
| `crmContext.*` | adapter pre-grafo o nodo `refresh_crm` opt-in | Carga única por turno; subgrafos pueden invalidar local sin re-fetch |
| `routing.activeSubgraph` | supervisor | Único nodo que decide a qué subgrafo se rutea |
| `routing.handoff` | supervisor o subgrafo activo (al abdicar) | Razón documentada |
| `subgraphState` | el subgrafo activo, en sus propios nodos | Cada subgrafo define su shape tipado |
| `outcome` | subgrafo activo al cerrar / supervisor en fast-paths | Discriminated union. Fast-paths incluyen el canned reply de contenido no soportado (`unsupportedContent.ts`) |

**Enforzar tipográficamente con channels y reducers de LangGraph.** Si un nodo intenta mutar un campo que no le pertenece, debe fallar en compile time.

### 8.3 — Mutaciones derivadas vs primarias

- **Primarias**: las del state global (tabla arriba).
- **Derivadas**: dentro del `subgraphState` cada subgrafo declara sus propios dueños internos. Ej. en `schedule.subgraphState.slots`, solo `resolve_entities` y `parseUserSlotReply` (puro) escriben `slots.*.value/uuid`. El LLM **nunca** escribe estos campos directamente (ver §9).

---

## 9. Anti-alucinación: state como única fuente de verdad

**LA REGLA MÁS IMPORTANTE DE ISLADEPLATA.** Es la reimplementación con LangGraph de la regla §8 de IDP v2.

### 9.1 — El LLM no decide datos críticos

Claude puede inventar UUIDs, fechas, horas, nombres. Isladeplata **NO** confía en valores que produce el LLM cuando esos valores van a un side-effect (commit en Guacuco). Defensa por capas:

1. **El commit es función pura, no tool LLM** — los nodos `commit_*` de cada subgrafo son código TS determinístico que lee del state. NO existe un agente ReAct decidiendo qué llamar en el último paso. La decisión ya se tomó en el grafo; el commit solo ejecuta.
2. **Los valores críticos vienen del state, no de los args del LLM** — `tenantAlliaId`, `profileUuid`, `serviceUuid`, `staffUuid`, `date.value`, `time.value` se leen de `state.identity` o `state.subgraphState.slots`. Nunca de un `tool_call.input.*`.
3. **Resolución de entidades centralizada en `resolve_entities`** — único nodo autorizado a convertir `displayName` (humano) → `uuid`. Hace fuzzy match LOCAL sobre `state.helpersLists` (que vino en identity resolve). NO se llama a Guacuco para resolución salvo casos excepcionales documentados.
4. **Parsing de fechas/horas en helper puro** — `parseUserSlotReply(text, locale, timezone)` es la única función autorizada a producir `date.value` o `time.value`. Determinística, testeable, sin LLM.

### 9.2 — Qué SÍ produce el LLM en cada subgrafo

- `ask_slot`: el texto en lenguaje natural que se le muestra al usuario (qué preguntar y cómo).
- `build_confirm_message`: el texto del mensaje confirmatorio (recibe solo `displayName`s, nunca UUIDs).
- `present_options`: el texto que acompaña la lista (la lista misma viene de Guacuco).
- `format_error`: el texto del mensaje de error al usuario.

El LLM **nunca** produce un `appointment_uuid`, `service_uuid`, `client_uuid`, `staff_uuid`, `business_allia_id`, ni un `date.value`/`time.value` final.

### 9.3 — Status del slot como gate

Cada slot tiene `status: 'empty' | 'guessed' | 'resolved'`. El nodo `commit_*` valida (assertion en runtime) que todos los slots required estén en `'resolved'`. Si no → `IdpError('invariant_violated', ...)`. Esto es la red de seguridad equivalente al `PostValidator` triple barrera de IDP v2.

### 9.4 — Confirmación antes de side-effect crítico

Tools de write crítico tienen `requiresConfirmation = true` por default (`schedule`, `cancel`, `reschedule`). Off para `confirm` (que ya es confirmatoria) y `check_availability` (read-only). El gate se implementa con `interrupt()` de LangGraph, no con state machine custom (ver §10.3).

---

## 10. Supervisor + Subgrafos

### 10.1 — Patrón general

El grafo tiene un **supervisor delgado** que clasifica y rutea, y **subgrafos especializados** para trámites complejos. Tools atómicas (sistema, support) cuelgan del supervisor directamente.

```
Supervisor (Haiku)
  ├── fast-path social (greeting/farewell/oos) — responde directo
  ├── atajo determinístico para button payloads (confirm:/cancel:/slot_pick:) — bypass LLM
  ├── tools atómicas (system/support) — un solo turno
  └── subgrafos (schedule/reschedule/cancel/query) — multi-turno con interrupts
```

### 10.2 — Supervisor corre SIEMPRE primero (incluso post-interrupt)

Cada turno entra por el supervisor, incluso cuando hay un subgrafo activo pausado en un `interrupt()`. El supervisor decide:

- **Reanudar subgrafo activo** (caso común): el mensaje responde a la pregunta del interrupt → `Command(resume=...)` al subgrafo.
- **Abdicar y cambiar intent**: el usuario cambió de opinión mid-flow → setea `routing.handoff`, descarta `subgraphState`, rutea al subgrafo nuevo.
- **Fast-path social**: responde directo, no toca `subgraphState`.
- **Atajo determinístico**: button payload con prefijo conocido → skip LLM, va directo al subgrafo activo.

**Tradeoff aceptado**: 1 LLM call extra por turno (Haiku, barato). Mitigación: atajos determinísticos saltan el LLM cuando el payload es estructurado.

### 10.3 — `requiresConfirmation` por tool

Default-on para tools de write crítico (`schedule`, `cancel`, `reschedule`). Default-off para `confirm`, `check_availability`, `query_database`, tools de sistema.

Mecánica: el subgrafo tiene un nodo `gate_confirm` justo antes del nodo `commit_*`. `gate_confirm`:
1. Llama `build_confirm_message` (Haiku, temp 0.3, ve solo displayNames + values renderizados, no UUIDs).
2. Genera button IDs `confirm:{intentUuid}` y `cancel:{intentUuid}` (intentUuid previene taps stale).
3. Llama `interrupt(payload)` → checkpoint, fin del turno.
4. Próximo turno: el supervisor reconoce el prefijo, despacha al subgrafo, `gate_confirm` valida `intentUuid` contra `state.subgraphState.confirmation.intentUuid` y rutea a `commit_*` o vuelve a `collecting`.

### 10.4 — Granularidad de `ask_slot`

Agrupar por afinidad semántica:
- **service**: aislado (list message).
- **staff**: aislado (list o botón "cualquiera disponible").
- **date + time**: **siempre juntos** (texto libre — NLU extrae ambos).
- **client_uuid** (solo cuando rol=staff agendando para tercero): aislado.

NUNCA agrupar todo de golpe (no entra en `list` de WhatsApp; cognitive load excesivo). NUNCA pedir uno-por-uno cuando un humano normalmente diría ambos juntos ("el jueves a las 4").

### 10.5 — Filtrado de tools/subgrafos por rol (en el supervisor, NO en el bootstrap)

El grafo se compila una sola vez. El supervisor, en cada turno, filtra qué tools/subgrafos están disponibles según `state.identity.profileType`:

- Cliente nunca ve `get_staff_appointments_summary`.
- Staff no ve `retrieve_manzanillo_url` (link público de booking).
- Si el tenant no tiene una feature activa (ej. MercadoPago no conectado), las tools relacionadas se ocultan.

El filtrado se hace removiendo la tool/subgrafo del set que recibe el LLM, **no** con instrucciones en el system prompt.

### 10.6 — Side-effect solo en el nodo final

Ningún subgrafo invoca writes en Guacuco hasta el nodo `commit_*` (post-confirmación cuando aplica). Todo lo previo es draft en `subgraphState` checkpointeado.

### 10.7 — Guard anti-loop

Cada subgrafo declara `meta.attempts` en su state. Si supera N (ej. 5), el subgrafo sale con `outcome.action='handed_off'` y el supervisor escala a humano o emite mensaje genérico. Previene loops infinitos cuando el usuario no entiende o el bot no logra resolver.

---

## 11. LLM (provider-agnóstico, modelos por nodo)

### 11.1 — `LlmProvider` es el contrato; los SDKs viven detrás de impls

Todo código de negocio (supervisor, nodos `ask_slot`, `build_confirm_message`, etc.) recibe un `LlmProvider` por constructor — **nunca** una clase concreta como `AnthropicProvider`. La selección del provider activo se hace al boot vía `createLlmProvider(env, logger)` y se rige por `env.LLM_PROVIDER` (`'anthropic'` | `'openai'`).

Impls actuales en `src/infrastructure/llm/`:

- `AnthropicProvider` — envuelve `@anthropic-ai/sdk`.
- `OpenAIProvider` — envuelve `openai`.

Reglas duras:

- **NO** importar `@anthropic-ai/sdk` ni `openai` fuera de su archivo de impl (y los tests específicos de esa impl).
- El contrato público (`LlmProvider`, `LlmMessage`, `LlmToolSpec`, `LlmToolCall`, `LlmCompleteInput`, `LlmCompleteOutput`) vive en `src/infrastructure/llm/LlmProvider.ts` y **no** filtra tipos de ningún SDK. Si un caller necesita un campo provider-específico, la abstracción está mal y hay que extender el contrato — no escaparse al SDK.
- Agregar un nuevo provider = nueva clase en `infrastructure/llm/`, una nueva rama en `createLlmProvider`, nuevas env vars en `config/env.ts` + `tests/setup.ts` + `.env.example`. Cero cambios fuera de esos archivos.

### 11.2 — Modelos por nodo (declarados en `config/llm.config.ts`)

Los configs por rol (`SUPERVISOR_CONFIG`, `RESPONSE_CONFIG`, `SOCIAL_CONFIG`) resuelven `model` en función de `env.LLM_PROVIDER`:

| Rol | Anthropic (default) | OpenAI (default) |
|---|---|---|
| Supervisor / clasificación | `SUPERVISOR_MODEL` (Haiku 4.5) | `OPENAI_SUPERVISOR_MODEL` (gpt-4o-mini) |
| Respuestas conversacionales | `RESPONSE_MODEL` (Haiku 4.5) | `OPENAI_RESPONSE_MODEL` (gpt-4o-mini) |
| Social fast-path | `RESPONSE_MODEL` (Haiku 4.5) | `OPENAI_RESPONSE_MODEL` (gpt-4o-mini) |

NUNCA hardcodear modelo, temperature, maxTokens, prompts. Todo por env + `llm.config.ts`. Si necesitás un modelo distinto para un rol específico (ej. razonamiento profundo en un subgrafo crítico), agregá un nuevo `*_CONFIG` con su par de env vars (`<ROL>_MODEL` para Anthropic, `OPENAI_<ROL>_MODEL` para OpenAI).

### 11.3 — Resilience ante fallos del LLM

- Si el SDK falla → respuesta determinística genérica + log `warn` + Sentry capture.
- Si el JSON del LLM no parsea → `parseLlmJson<T>(raw, logger, {component})` retorna `null`; el caller decide default (fail-open vs fail-closed).
- En supervisor, fallo de clasificación → fast-path "lo siento, no entendí, podés repetir?" sin tocar `subgraphState`.

### 11.4 — Construcción uniforme de `messages[]`

`buildUserMessageChain(recentMessages, currentMessage)` en `infrastructure/llm/`. Centraliza el patrón de mapear `state.messages` al shape del SDK. NO duplicar.

### 11.5 — Sanitización pre-LLM

Todo texto del usuario pasa por `sanitizeUserInput()` (security/guardrails.ts): trunca a 10,000 chars, strip HTML, normaliza whitespace. NUNCA enviar raw al LLM.

---

## 12. Canales (WhatsApp dual + agnosticidad)

### 12.1 — Estructura por canal

Cada canal en `channels/{name}/`:
- `webhook.ts` o `handler.ts` — entry point HTTP
- `normalizer.ts` — payload externo → `ChannelMessage`
- `sender.ts` — `ChannelMessage` → API externa
- `types.ts` — tipos del payload externo
- `{Name}InboundAdapter.ts` — implementa `InboundChannelAdapter` (monta sus rutas + body-parser propio)

NUNCA mezclar lógica entre canales. Si dos canales necesitan lo mismo → `ChannelAdapter.ts` o `core/`.

`channels/ChannelAdapter.ts` define dos contratos: `MessageProcessor` (canal → pipeline) e `InboundChannelAdapter` (canal → Express: `{ channelType; register(app, processor) }`).

### 12.1.1 — `ChannelMessage` estandarizado (entrante)

Todo mensaje entrante se normaliza a un `ChannelMessage` con un discriminador `contentType` REQUERIDO (`core/enums/InboundContentType.ts`: `text | interactive | template_button | image | audio | video | document | location`). El normalizer DEBE setearlo en toda rama; `contentText` es el texto humano canónico para todo tipo (caption en media, name/address en location). Payloads estructurados opcionales: `media` (image/audio/video/document), `location`, `templateButton` (`contextMessageId` + `payload`; solapa a propósito con `interactivePayload`, que sigue siendo el carrier de routing de `detectButtonShortcut`/resume). Contenido no procesable (media/location) NO se dropea: se transporta y el supervisor responde un canned reply sin LLM (ver §8.2 / `graph/supervisor/unsupportedContent.ts`).

### 12.2 — Multi-Platform WhatsApp (dual cliente/staff)

WhatsApp tiene un `phone_number_id` por **(plataforma, rol)** (heredado de IDP v2 §11.2). Hoy: Divapp staff, Divapp client, Groomia staff, Groomia client, Allia staff, Allia client.

`config/channels.config.ts` mantiene:
- `WHATSAPP_CHANNEL_MAP: phone_number_id → {accessToken, role: 'staff'|'client', platformId}`
- `APP_SECRET_BY_PLATFORM: platformId → app_secret`

**Reglas:**
- Normalizer rellena `whatsappChannel: 'staff'|'client'` en `ChannelMessage`.
- `IdentityResolver` consulta Guacuco con `(channelType, channelId, phoneNumberId)`. El `profileType` resultante refleja el rol del phone_number_id.
- `state.identity.profileType` viene del map + Guacuco — **NUNCA del LLM, NUNCA del payload del usuario**.
- HMAC del webhook entrante: el handler pre-parsea el body (untrusted) solo para extraer `phone_number_id`, resuelve `WhatsAppPhoneConfig` y luego mira `APP_SECRET_BY_PLATFORM.get(cfg.platformId)` para elegir el secret antes de validar firma. Los datos parseados NO se usan para business logic hasta después de validar HMAC. Dev-only: `WHATSAPP_SKIP_SIGNATURE=true` saltea el HMAC (jamás en producción; el parse de `env.ts` hace fail-fast si combinás esa flag con `NODE_ENV=production`).

### 12.3 — Agnosticidad de canal

El grafo NO conoce el canal de origen. `state.identity.channel` es informativo y se usa solo en `ResponseBuilder` y para el `thread_id`. Para agregar Telegram/web/mobile basta:

1. Crear `channels/{nuevo}/` con normalizer + sender + un `{Nuevo}InboundAdapter` que implemente `InboundChannelAdapter`.
2. Push del adapter al array `inboundChannels` en `bootstrap.ts` (lo demás lo itera `registerRoutes`).
3. (Opcional) extender `ResponseBuilder` con formato específico.
4. **El grafo no se toca.**

### 12.4 — `CHANNEL_FORMATS` centralizado

Límites de cada plataforma viven en `config/channel-formats.config.ts`. WhatsApp: text 4096, body 1024, ≤3 buttons, list ≤10 rows, button title 20, row title 24, row description 72.

**NUNCA hardcodear límites de Meta/Telegram** en `ResponseBuilder`, senders, o nodos del grafo — siempre leer de `CHANNEL_FORMATS[channelType]`. Si Meta/Telegram actualizan API, se edita un archivo.

### 12.5 — Webhook responde 200 SIEMPRE (excepto auth fail)

Ver §7.4.

---

## 13. Seguridad + Errores + Logging

### 13.1 — Seguridad (no negociable)

1. NUNCA hardcodear secretos. Todo en `.env`, validado por Zod en `env.ts`.
2. NUNCA logear API keys, JWTs, access tokens completos, bodies crudos de webhook, texto del usuario sin truncar.
3. Validación de firmas centralizada en `validateWebhookSignature({type, ...})` con `crypto.timingSafeEqual`. NUNCA comparar con `===`.
4. SIEMPRE sanitizar input del usuario antes del LLM (`sanitizeUserInput`).
5. `JWT_SECRET ≥ 32 chars`, `IDP_API_KEY ≥ 16 chars`. Validado por Zod.
6. CORS y Helmet aplicados en `createApp()`. CORS abierto por default; whitelist explícita si cambia.
7. Para teléfonos en logs: `maskPhoneNumber()` siempre.

### 13.2 — Jerarquía de errores

```
IdpError(code, message)         // base — code snake_case
├── IdentityNotFoundError       // Guacuco 404 en /identity/resolve (cliente sin business)
├── RateLimitError
├── ToolExecutionError(code, message)  // Guacuco envelope success: false
└── (uso especial) IdpError('invariant_violated', ...) // condiciones que el código garantiza
```

NUNCA `new Error('...')` desde `clients/`, `pregraph/`, `graph/`, `channels/`, `nlg/`. Usar `core/errors/`.

### 13.3 — Outcome como discriminated union, no excepciones para control de flujo

El subgrafo retorna outcome via state (`{action, pendingReply?}`). Excepciones se usan solo para **errores no esperados** (red caída, invariant violated, bug en código). El catch global del pre-grafo:

1. `logger.error` con stack
2. `captureIdpError` a Sentry con contexto
3. Respuesta determinística genérica al usuario

### 13.4 — Logging

Winston con JSON estructurado en producción. **NO** `console.log/error`.

Niveles:
- `debug`: tracing fino (default off en prod)
- `info`: eventos significativos (turn started, subgraph entered, commit succeeded)
- `warn`: anomalías recuperables
- `error`: fallos del pipeline, stack traces

Contexto estructurado, NO string interpolation:
```typescript
logger.info('Subgraph entered', { subgraph: 'schedule', threadId, profileType });  // CORRECTO
```

**Política específica de logging conversacional**:
- Solo última entrada user + última assistant del turno actual, **truncadas y enmascaradas**.
- El thread completo es recuperable desde el checkpointer si hace falta debug puntual.
- NUNCA logear el `messages[]` completo en cada turno.

### 13.5 — Fire-and-forget vía `swallowAsync`

Operaciones secundarias (persistir turno a Guacuco, signals a Parguito, métricas) usan `swallowAsync(logger, label, promise, ctx?)` de `infrastructure/observability/`. Nivel SIEMPRE `warn`. **NUNCA** `.catch(() => {})` silencioso (pierde observabilidad).

### 13.6 — Tracing con LangSmith

LangSmith es el sistema oficial de tracing del agente. Complementa Sentry (que captura excepciones no esperadas): **Sentry = errores; LangSmith = visibilidad operativa del LLM y del grafo**.

**Qué se trackea (cuando `LANGSMITH_TRACING=true`)**:
- Cada `invoke` del grafo compilado (supervisor + subgrafos).
- Cada llamada LLM (prompts, respuesta, tokens, latencia, modelo).
- Cada tool call interno del grafo (input, output, error si aplica).
- Latencias por nodo y por turno.
- Costo agregable por modelo y por proyecto.

**Qué NO se trackea**:
- Llamadas HTTP a Guacuco/Parguito que NO pasan por una `tool` del grafo (RetryClient directo desde pre-grafo). Para observabilidad de esas, Sentry + métricas + logs estructurados.
- Lógica determinística del pre-grafo (dedup, identity resolve, rate limit). Esto vive en logger + Sentry.

**Configuración (env vars, ver `config/env.ts`)**:
- `LANGSMITH_TRACING`: `'true'` activa el tracing. Default `false`.
- `LANGSMITH_API_KEY`: requerido si `TRACING=true`. Si está vacío con tracing activo, el wrapper debe loguear `warn` y no inicializar (no romper el agente).
- `LANGSMITH_PROJECT`: nombre del proyecto en LangSmith. Default `isladeplata-dev`. En producción usar `isladeplata-prod` (o similar) para separar.
- `LANGSMITH_ENDPOINT`: opcional, default cloud US. Setear si se usa endpoint EU/self-hosted.
- `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS`: en producción **recomendado `true`** para no enviar PII (texto del usuario, mensajes con datos personales) al servicio externo. En staging/dev típicamente `false` para debugging.

**Inicialización**:
- LangSmith se inicializa en el composition root (`bootstrap.ts`), después de validar env y antes de compilar el grafo (paso 4-5 del orden de boot).
- El SDK detecta las env vars automáticamente; no se requiere wiring manual de cada nodo. Para spans/traces custom fuera del grafo (ej. logic determinística que queremos visualizar), usar `traceable()` de `langsmith`.

**Política de datos sensibles**:
- En `production`, `HIDE_INPUTS` y `HIDE_OUTPUTS` deben ser `true` salvo justificación explícita en `bootstrap.ts` con razón documentada.
- Tokens, API keys, secrets — **NUNCA** llegan al state del grafo, así que tampoco a LangSmith por construcción.
- Teléfonos de usuario: si `HIDE_INPUTS=false`, asegurarse de que los inputs al LLM ya pasan por `sanitizeUserInput()` (que NO enmascara teléfonos por defecto — la masking se aplica solo a logs estructurados). Para LangSmith: si la organización es multi-tenant, considerar `HIDE_INPUTS=true` por privacidad cross-tenant.

**No-go**:
- NUNCA hardcodear API key de LangSmith. NUNCA loguear el API key.
- NUNCA setear `TRACING=true` en producción sin antes haber configurado `HIDE_INPUTS=true` o haber validado que el contenido del state cumple política de privacidad.
- NUNCA reusar el mismo proyecto de LangSmith entre dev/staging/prod — separa métricas y mezcla ruido en quality reviews.

---

## 14. Testing (Vitest)

### 14.1 — Framework: Vitest, NO Jest

`vitest.config.ts` con `globals: false` (importar `describe/it/expect/vi` explícito), `environment: 'node'`, `setupFiles: ['./tests/setup.ts']`.

### 14.2 — Tests fuera del source

`tests/unit/` y `tests/integration/`. NO colocados con el código. Naming: `{Artefacto}.test.ts`.

### 14.3 — `tests/setup.ts` inyecta env vars dummy

`config/env.ts` parsea con Zod al cargarse. Si añades env var nueva en `env.ts`, **también añádela aquí** o todos los tests fallan.

### 14.4 — Prioridades (qué testear primero)

1. **Anti-alucinación** (§9): `resolve_entities` con casos ambiguos, nodos `commit_*` con assertion de slots resolved, `parseUserSlotReply` con inputs degenerados.
2. **Subgrafos críticos**: `schedule` end-to-end con mocks de Guacuco (happy path, slot ocupado → present_options → user picks, race en commit, cancel implícito, guard anti-loop).
3. **Supervisor**: clasificación correcta, atajo determinístico para button payloads, handoff cross-subgrafo, fast-path social.
4. **Checkpointer + resume**: thread expirado → fresco, thread interrupted → resume correcto, TTL inline.
5. **Identity dual**: filtrado de tools por rol, cross-business protection (mascarado en read, explícito en write).
6. **Pre-grafo**: dedup, rate limit, welcome flow (staff vs client), HMAC timing-safe.
7. **Resilience**: `RetryClient` policy, `parseLlmJson` con respuestas degenerates, fallback determinístico ante fallo del SDK Anthropic.
8. **Canales**: normalizers, senders, formato por `CHANNEL_FORMATS`.

### 14.5 — Mocking

Mockear SOLO los métodos que el artefacto bajo test usa. Usar `vi.fn()`, no `jest.fn()`. `afterEach(() => vi.clearAllMocks())`.

### 14.6 — Fire-and-forget tests

Los componentes fire-and-forget deben **resolver exitosamente incluso cuando sus deps fallan**:
```typescript
mockGuacuco.persistTurn.mockRejectedValue(new Error('Guacuco down'));
await expect(persister.persist(turn)).resolves.not.toThrow();
```

---

## 15. Convenciones generales

### 15.1 — Composición sobre herencia

Una excepción canónica: `BaseHttpClient` ← `GuacucoClient`, `ParguitoClient`. Cualquier otro `extends` requiere justificación en PR.

### 15.2 — Naming

- Archivos: `PascalCase.ts` para clases, `camelCase.ts` para funciones puras (ej. `parseUserSlotReply.ts`)
- Clases: `PascalCase`
- Variables y funciones: `camelCase`
- Constantes top-level: `UPPER_SNAKE_CASE`
- Tipos e interfaces: `PascalCase` (sin prefijo `I` salvo contratos implementados por múltiples adapters)

### 15.3 — Un componente, un archivo

Una clase pública por archivo. El archivo se llama igual que la clase. Excepción: tipos auxiliares pequeños usados solo en ese archivo.

### 15.4 — Inmutabilidad cuando sea trivial

Configuraciones y constantes son `as const`. State del grafo se trata como inmutable desde la perspectiva de los nodos (cada nodo retorna un parcial, LangGraph aplica el reducer).

### 15.5 — JSDoc para componentes públicos

Cada clase pública incluye:
- Qué hace
- Quién la usa
- Invariantes / decisiones de diseño no obvias

### 15.6 — Historial conversacional acotado

Cap de `messages` en el state (default 5 últimos turnos). El reducer del state aplica el cap automáticamente. NUNCA mutar `messages` directo desde un nodo.

### 15.7 — Funciones protegidas (TIER 1 / TIER 2)

Equivalente al §19 de IDP v2. Lista canónica a definir al codear; candidatos TIER 1:
- Los nodos `commit_*` de cada subgrafo (writes a Guacuco)
- `resolve_entities` (única fuente de UUIDs)
- `parseUserSlotReply` (única fuente de date/time values)
- `gate_confirm` (mecánica de confirmation)
- Supervisor router (decide qué subgrafo se activa)
- `validateWebhookSignature` (auth)
- `BaseHttpClient.unwrap` (contrato de errores)
- Orden de pasos del pre-grafo
- Orden de cleanup en bootstrap

Modificación requiere: leer archivo completo → presentar propuesta → esperar aprobación del owner → `npm run typecheck` + `npm test` → preferir código nuevo junto al existente.

---

## 16. Checklist: NUNCA / SIEMPRE

### NUNCA

- Importar `pg`, `kysely`, `prisma` o driver SQL del negocio (excepción: `infrastructure/checkpointer/` para el Postgres del agente)
- Importar `@anthropic-ai/sdk` o `openai` directo fuera de su archivo de impl en `infrastructure/llm/` (los callers usan `LlmProvider`)
- Tipar un nodo o supervisor como `AnthropicProvider`/`OpenAIProvider` — usar `LlmProvider`
- Importar `@langchain/langgraph` desde `core/`, `clients/`, `channels/`, `nlg/`
- Usar `axios` directo (usar `RetryClient` o subclase de `BaseHttpClient`)
- Usar `any` en TypeScript
- Olvidar `.js` en imports ESM
- Lanzar `new Error('...')` desde `clients/`, `pregraph/`, `graph/`, `channels/`, `nlg/` (usar `IdpError` u otra clase de `core/errors/`)
- Confiar en valores producidos por el LLM para writes (UUIDs, fechas, horas finales) — siempre vienen del state
- Pasar `tenantUuid`/`profileUuid`/`profileType` desde el payload del usuario o desde el LLM — siempre del `state.identity`
- Eliminar la validación de slots resolved en `commit_*` "porque ya viene del state"
- Almacenar keys en Redis sin TTL
- Hardcodear secretos, modelos LLM, timeouts, maxTokens, temperatures, prompts, límites de canal
- Cambiar el provider activo en producción sin probarlo primero con `LLM_PROVIDER=<otro>` en dev/staging
- Comparar HMAC/signatures con `===`
- Logear API keys, tokens, JWTs, bodies crudos de webhook, `messages[]` completo, texto sin truncar
- Aplicar `express.json()` globalmente (rompe HMAC del webhook WA — body parser por ruta)
- Retornar 5xx desde un webhook por errores de procesamiento
- Mutar bloques del state que no son del nodo actual (ver tabla §8.2)
- Mutar `state.identity` o `state.input` desde adentro del grafo
- Construir mensajes confirmatorios que incluyan UUIDs o IDs internos
- Modificar el orden de pasos del pre-grafo o del bootstrap sin entender consecuencias
- Crear `.md` en raíz del proyecto salvo `README.md` y `CLAUDE.md`
- Usar `Jest`, `jest.fn()`, o globals de testing sin import
- Añadir env var nueva en `env.ts` sin actualizar `tests/setup.ts`
- Setear `LANGSMITH_TRACING=true` en producción sin haber configurado `HIDE_INPUTS=true` o validado privacidad del state
- Reusar el mismo `LANGSMITH_PROJECT` entre dev/staging/prod
- Hardcodear el `LANGSMITH_API_KEY` o logearlo

### SIEMPRE

- Validar firmas de webhook vía `validateWebhookSignature` (timing-safe)
- Sanitizar input del usuario antes del LLM (`sanitizeUserInput`)
- Leer `tenantAlliaId`/`profileUuid`/`uuid`s del state al construir requests a Guacuco
- Pasar por `resolve_entities` para convertir nombres → UUIDs
- Pasar por `parseUserSlotReply` para parsear fechas/horas del usuario
- Asertar `status === 'resolved'` de todos los slots required antes de `commit_*`
- Usar `interrupt()` para preguntar al usuario / pedir confirmación (no state machine custom)
- Pasar errores externos por `core/errors/*` (`IdpError`, `IdentityNotFoundError`, `ToolExecutionError`)
- Centralizar envelope unwrap en `BaseHttpClient.unwrap`
- Nuevos HTTP clients heredan de `BaseHttpClient`
- Setear TTL explícito en Redis writes
- Inyectar `logger` y deps por constructor
- Wirear cualquier construcción nueva en `bootstrap.ts`
- Registrar rutas en `registerRoutes` (no en `bootstrap.ts`)
- Body parser por ruta, nunca global
- Catch global del pre-grafo → Sentry + respuesta genérica al usuario
- Fire-and-forget vía `swallowAsync(logger, label, promise, ctx?)`
- Leer límites de formato de canal desde `CHANNEL_FORMATS`
- Verificar TTL del checkpoint inline + correr job periódico de cleanup
- Logear con contexto estructurado (`logger.info(msg, {...ctx})`)
- Enmascarar teléfonos en logs (`maskPhoneNumber`)
- Verificar con `npm run typecheck` y `npm test` antes de commit
- Documentar excepciones a las reglas con comentarios `// Razón: ...`
- Defaults seguros ante fallo del LLM (clasificación → fast-path social, JSON parse → null + default)
- Filtrar tools/subgrafos por rol en el supervisor (no en el system prompt)
- Separar proyecto de LangSmith por entorno (`isladeplata-dev`, `isladeplata-staging`, `isladeplata-prod`)
- En producción: `LANGSMITH_HIDE_INPUTS=true` y `LANGSMITH_HIDE_OUTPUTS=true` salvo justificación documentada

---

> **Cambios a este documento**: cada vez que se modifique una regla, el PR debe incluir actualización de esta sección y justificación. Si una regla queda obsoleta por evolución del proyecto, marcarla como `DEPRECATED` con fecha antes de removerla en un PR posterior.
