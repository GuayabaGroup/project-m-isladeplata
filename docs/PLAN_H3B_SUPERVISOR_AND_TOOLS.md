# Plan H3.B — Supervisor LLM + Tools Atómicas + Button Shortcuts

> Segunda mitad de H3. Reemplaza el nodo `echo` dummy de H3.A por el supervisor real (Haiku classifier + fast-path social + atajos button + filtrado por rol) y agrega las 4 tools atómicas que cuelgan directo del supervisor.
>
> Pre-requisitos: H3.A committeado (`c7518e1`). Plan en sub-pasos commiteables.

---

## 0. Contexto

El supervisor es la "puerta" del grafo: cada turno entra por acá, **siempre primero**, incluso post-`interrupt()`. Decide:

- **Fast-path social** (greeting/farewell/oos): responde directo con Haiku, no toca subgraphState.
- **Atajo determinístico para button payloads** (`confirm:*` / `cancel:*` / `slot_pick:*`): bypasea LLM, va al subgrafo activo con `Command(resume=...)`.
- **Tool atómica** (system / support): un solo turno, sin estado intermedio.
- **Subgrafo** (schedule / reschedule / cancel / query): multi-turno, con interrupts. **En H3.B aún no hay subgrafos** — el router los reconoce y produce un placeholder outcome `{action: 'handed_off', text: 'Funcionalidad próximamente'}`. H4 los enchufa.

**Reglas clave** (heredadas de [`REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §10):

- Filtrado de tools/subgrafos por rol vive en el supervisor — no en el system prompt.
- 1 LLM call extra por turno como tradeoff aceptado. Mitigación: atajos determinísticos.
- Default seguro ante fallo del classifier → fast-path social ("no entendí, podés reformular?").

---

## 1. AnthropicProvider + `llm.config.ts`

### 1.1 Env vars nuevas

```
ANTHROPIC_API_KEY=        # .startsWith('sk-ant-')
SUPERVISOR_MODEL=         # default 'claude-haiku-4-5-20251001'
RESPONSE_MODEL=           # default 'claude-haiku-4-5-20251001'
# Sonnet se reserva para H4+ (SUBGRAPH_REASONING_MODEL); no en H3.B
```

Agregar a `src/config/env.ts` + `tests/setup.ts` + `.env.example`.

### 1.2 `AnthropicProvider`

`src/infrastructure/llm/AnthropicProvider.ts`:

- Wrap único del SDK `@anthropic-ai/sdk` (REGLAS §9.2 — único punto de import del SDK).
- Constructor recibe `apiKey` (de env), `logger`.
- API: `complete({model, system, messages, tools?, temperature, max_tokens})` → returns `{text, toolCalls, stopReason, usage}`.
- Manejo defensivo: `try/catch` el SDK call, retorna shape estándar con `text=''` + log `warn` en fallo. **Nunca lanza** (§9.4 — defaults seguros).
- Sin streaming en H3.B (más simple). Si se necesita, se agrega después.

### 1.3 `llm.config.ts`

`src/config/llm.config.ts` declara configs por nodo:

```typescript
export const SUPERVISOR_CONFIG = {
  model: env.SUPERVISOR_MODEL,
  temperature: 0.2,
  maxTokens: 256,
} as const;

export const RESPONSE_CONFIG = {
  model: env.RESPONSE_MODEL,
  temperature: 0.7,
  maxTokens: 300,
} as const;

export const SOCIAL_CONFIG = {
  model: env.RESPONSE_MODEL,
  temperature: 0.7,
  maxTokens: 150,
} as const;
```

No hardcodear modelos/temp/maxTokens fuera de este archivo (§9.3).

### 1.4 Tests

- `AnthropicProvider` con SDK mockeado (mock `messages.create`): happy + text response + tool_use response + error path (retorna shape vacío).
- `llm.config.ts` snapshot test (verifica que models vienen de env, no hardcoded).

---

## 2. Utilidades LLM compartidas

### 2.1 `parseLlmJson`

`src/core/parseLlmJson.ts`:

```typescript
export function parseLlmJson<T>(
  raw: string,
  logger: Logger,
  context: { component: string },
): T | null;
```

- Extrae bloque JSON del texto (puede estar en markdown ```json ... ```, o entre el texto, o crudo).
- Retorna `T | null` — caller decide default fail-open vs fail-closed.
- `null` cuando no hay JSON detectable o el parse falla. Log `warn` con context.

### 2.2 `buildUserMessageChain`

`src/infrastructure/llm/buildUserMessageChain.ts`:

```typescript
export function buildUserMessageChain(
  recentMessages: BaseMessage[],
  currentText: string,
): Array<{role: 'user' | 'assistant'; content: string}>;
```

- Convierte `state.messages` (BaseMessage[] de LangChain) al shape del SDK Anthropic.
- Appendea el texto del turno actual como último `user` message.
- Helper para evitar duplicación en cada nodo LLM.

### 2.3 Tests

- `parseLlmJson` con inputs degenerados (raw vacío, JSON inválido, JSON parcial, JSON en markdown, JSON con preámbulo, JSON con texto trailing).
- `buildUserMessageChain` con messages varios + cap behavior.

---

## 3. Supervisor (5 componentes en orden)

### 3.1 `buttonShortcut.ts` (determinístico)

`src/graph/supervisor/buttonShortcut.ts`:

Función pura. Toma `state.input.channelMessage.interactivePayload` y decide:

| Payload ID prefix | Decisión |
|---|---|
| `confirm:<uuid>` | Resume subgrafo activo con `{kind: 'confirm', intentUuid}` |
| `cancel:<uuid>` | Resume subgrafo activo con `{kind: 'cancel', intentUuid}` |
| `slot_pick:<idx>` | Resume subgrafo activo con `{kind: 'pick', index}` |
| `service:<uuid>` / `staff:<uuid>` | Resume subgrafo activo con `{kind: 'service_pick' \| 'staff_pick', uuid}` |
| ningún match | Retorna `null` — el supervisor continúa al LLM classifier |

Retorna `{shortcut: 'resume_subgraph'} | null`. El router decide qué hacer.

### 3.2 `classifyIntent.ts` (LLM nodo)

`src/graph/supervisor/classifyIntent.ts`:

Llama AnthropicProvider con `SUPERVISOR_CONFIG`. Prompt sistema:

```
Sos un clasificador de intent para un agente de turnos. Devolvé SOLO JSON
con shape {messageType, confidence, intent?}.

messageType es uno de:
- 'greeting'    — hola, buenas, cómo estás, gracias
- 'farewell'    — chau, adiós, hasta luego
- 'oos'         — fuera de scope (clima, política, etc.)
- 'action'      — el usuario quiere hacer algo (agendar, cancelar, etc.)
- 'query'       — pregunta informativa (precio, horario, servicios)

Si messageType='action', incluí `intent` con uno de:
- 'schedule', 'reschedule', 'cancel', 'confirm', 'unknown'

confidence: número 0-1.
```

Output: parsed JSON via `parseLlmJson` con fail-open a `{messageType: 'action', intent: 'unknown', confidence: 0.3}`. Nunca rompe.

Input al LLM: solo el `channelMessage.contentText` sanitizado + el system prompt. No CRM, no identity (no necesario para clasificar).

### 3.3 `socialResponder.ts` (LLM nodo)

`src/graph/supervisor/socialResponder.ts`:

Para `messageType in ['greeting', 'farewell', 'oos']`. Genera respuesta corta. Prompt:

```
Sos un agente de atención al cliente para {{businessName}} ({{platformName}}).
Respondé en máximo 2 oraciones, tono amable y conciso.

Contexto: {{messageType === 'greeting' ? 'el usuario te saluda' : ...}}
{{messageType === 'oos' ? 'redirigílo gentilmente a temas de agenda/turnos sin ser cortante' : ''}}
```

Recibe `state.identity.tenantName` (de `businessStaffRoles.business_name`) y `platformName` (mapeo platformId → 'Allia'|'Groomia'|'Divapp'). 

Output: `{outcome: {action: 'response', pendingReply: {text}}}`.

### 3.4 `filterTools.ts` (determinístico)

`src/graph/supervisor/filterTools.ts`:

Función pura: `getAvailableTools(identity: Identity): Set<string>`.

| `profileType` | Tools/subgrafos disponibles |
|---|---|
| `client` | `schedule`, `reschedule`, `cancel`, `confirm`, `query_database`, `retrieve_manzanillo_url`, `generate_verification_url`, `forward_message` |
| `staff` | + `get_staff_appointments_summary` (post-H3.B; no en este hito), `connect_mercado_pago` |

`retrieve_manzanillo_url` solo client. `connect_mercado_pago` solo staff.

### 3.5 `router.ts` (conditional edge)

`src/graph/supervisor/router.ts`:

Función pura. Inputs: output del classifier + `state.identity` + button shortcut result. Output: nombre del próximo nodo (`'social' | 'tool_<name>' | 'subgraph_<name>' | 'handoff'`).

Lógica:

```
if (buttonShortcut !== null && routing.activeSubgraph) {
  return 'subgraph_resume';
}
if (messageType in ['greeting', 'farewell', 'oos']) {
  return 'social';
}
if (intent === 'schedule')   return 'subgraph_schedule';  // placeholder en H3.B
if (intent === 'reschedule') return 'subgraph_reschedule';
if (intent === 'cancel')     return 'subgraph_cancel';
if (intent === 'confirm')    return 'subgraph_confirm';
if (intent === 'query')      return 'subgraph_query';
if (intent === 'unknown' && confidence < 0.5) return 'social_oos'; // baja confianza → trato como oos
// Tools atómicas detectadas heurísticamente — el classifier en v1 no las distingue;
// caen como 'action' y se filtran acá por keywords ("link", "verificar", "mercadopago", "forward")
// Para v1: si action sin intent reconocido → 'social_unknown'.
return 'social_unknown';
```

Filtrado por rol acá: si tool/subgrafo no está en `getAvailableTools(identity)` → `'social_unknown'` con respuesta "no tenés permiso para eso" (o más amable).

### 3.6 Tests del supervisor

- `buttonShortcut`: payloads varios (confirm/cancel/pick/service/staff) y free-text → null.
- `classifyIntent`: con AnthropicProvider mockeado retornando varios JSONs (incluyendo parseable y degenerado). Verificar fail-open al default seguro.
- `socialResponder`: con AnthropicProvider mockeado, verifica que el outcome se construye con el texto generado.
- `filterTools`: para client vs staff retorna sets esperados.
- `router`: cada branch testeado con inputs construidos.

---

## 4. Tools atómicas

Cada tool implementa una interfaz común:

```typescript
// src/graph/tools/Tool.ts
export interface Tool {
  name: string;
  /** Roles allowed to invoke this tool. */
  allowedRoles: ReadonlyArray<'client' | 'staff'>;
  /** Run the tool with state context. Returns a partial state update. */
  run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate>;
}

export interface ToolDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}
```

### 4.1 `retrieve_manzanillo_url`

`src/graph/tools/system/retrieveManzanilloUrl.ts`:

- `allowedRoles: ['client']`
- Llama `guacuco.executeTool<{url}>('retrieve_manzanillo_url', {}, {context: {profile_uuid}})`.
- Output: `{outcome: {action: 'response', pendingReply: {cta: {text: 'Acá tenés tu link de reservas', url, displayText: 'Abrir'}}}}`.

### 4.2 `generate_verification_url`

`src/graph/tools/system/generateVerificationUrl.ts`:

- `allowedRoles: ['client', 'staff']`
- Llama `guacuco.executeTool<{url}>('generate_verification_url', {}, {context: {profile_uuid}})`.
- Output: cta con URL.

### 4.3 `connect_mercado_pago`

`src/graph/tools/system/connectMercadoPago.ts`:

- `allowedRoles: ['staff']`
- Llama `guacuco.executeTool<{url}>('connect_mercado_pago', {}, {context: {business_allia_id}})`.
- Output: cta para conectar.

### 4.4 `forward_message`

`src/graph/tools/support/forwardMessage.ts`:

- `allowedRoles: ['client', 'staff']`
- `requiresConfirmation: true` (porque manda mensaje a tercero — default-on para writes que afecten a otros)
- Para v1 sin confirmation: skip el gate (no estamos en subgrafo); ejecuta directo.
- Llama `guacuco.executeTool('forward_message', {original_message: contentText}, {context})`.
- Output: confirmación "Tu mensaje fue enviado al negocio".

Cómo se detectan estas tools en el router: en H3.B, **se invocan SOLO via comandos explícitos del usuario** que el classifier identifica como `intent='action'` + `unknown`. El router hace un segundo paso de heurística por keywords:

```typescript
function detectAtomicTool(text: string, role: ProfileType): string | null {
  const lower = text.toLowerCase();
  if (/link|reserva|booking/.test(lower) && role === 'client') return 'retrieve_manzanillo_url';
  if (/verif|acceso|login/.test(lower)) return 'generate_verification_url';
  if (/mercado.?pago|cobros/.test(lower) && role === 'staff') return 'connect_mercado_pago';
  if (/llegar tarde|estoy afuera|estacionamiento/.test(lower)) return 'forward_message';
  return null;
}
```

**Decisión a fijar (§7)**: ¿esta heurística es suficiente o requerimos un classifier más fino del Haiku? Mi recomendación: empezar con heurística, evaluar después de un piloto.

---

## 5. Reemplazar nodo `echo` en `compile.ts`

`src/graph/compile.ts` cambia significativamente. Estructura nueva:

```
START → supervisor.entry
supervisor.entry → buttonShortcut → conditional edge:
  - if shortcut: → 'subgraph_resume' (en H3.B: placeholder handoff)
  - else: → classifyIntent
classifyIntent → router → conditional edge per branch:
  - 'social' → socialResponder → END
  - 'tool_<name>' → ejecuta la tool → END
  - 'subgraph_<name>' → placeholder handoff (en H3.B) → END
  - 'social_unknown' → socialResponder (con flag oos) → END
```

Nodos nuevos: `supervisor_entry`, `button_shortcut`, `classify_intent`, `social_responder`, `tool_retrieve_manzanillo`, `tool_generate_verification`, `tool_connect_mp`, `tool_forward_msg`, `subgraph_placeholder`.

Wire del subgrafo placeholder (en H3.B):
```typescript
function subgraphPlaceholder(state: GraphState): GraphStateUpdate {
  const subgraphName = inferSubgraphFromRouting(state); // del router
  return {
    outcome: {
      action: 'handed_off',
      pendingReply: { text: `Funcionalidad "${subgraphName}" próximamente. Un humano te va a contactar.` },
    },
  };
}
```

Eso permite que el supervisor funcione end-to-end aunque los subgrafos reales no existan todavía.

### 5.1 Tests de integración

- Cliente envía "hola" → social fast-path responde Haiku.
- Cliente envía "quiero el link" → `retrieve_manzanillo_url` ejecuta, responde con CTA.
- Staff envía "conectar mercadopago" → `connect_mercado_pago` ejecuta.
- Cliente envía "quiero agendar" → subgraph_placeholder ("próximamente").
- Cliente envía button payload `confirm:fake-uuid` con `routing.activeSubgraph=null` → subgraph_resume nodo detecta y retorna ignored (no hay subgrafo activo).
- Mensaje fuera de scope ("cómo está el clima") → social con oos handler.

---

## 6. Plan de implementación (sub-hitos H3.B.x)

| Sub-hito | Entregables | DoD |
|---|---|---|
| H3.B.1 | AnthropicProvider + llm.config.ts + env vars + tests | typecheck + tests passan; mock SDK retorna text + tool_use |
| H3.B.2 | parseLlmJson + buildUserMessageChain + tests | 100% cobertura de paths degenerados |
| H3.B.3 | buttonShortcut + classifyIntent + socialResponder + filterTools + tests unitarios | cada componente verde aislado |
| H3.B.4 | Tools atómicas (4 archivos) + tests con GuacucoClient mockeado | cada tool retorna outcome estructurado |
| H3.B.5 | router.ts + reemplazo de nodo echo en compile.ts + placeholder de subgrafos + tests integración | los 6 tests del §5.1 verdes |
| H3.B.6 | Update SPRINT.md + CLAUDE.md + commit H3.B + marcar H3 ✅ | sesión de validación end-to-end |

---

## 7. Decisiones a fijar antes de codear H3.B

| # | Decisión | Recomendación |
|---|---|---|
| 1 | ¿Heurística de keywords o sub-classifier LLM para tools atómicas? | **Heurística** v1, evaluar después |
| 2 | ¿`socialResponder` recibe historial conversacional (state.messages) o solo el turno actual? | **Solo turno actual** v1 — más simple, latencia menor; agregar history si el bot se siente "sin memoria" |
| 3 | ¿El supervisor logea cada classify a LangSmith con `traceable`, o usa el tracing nativo del invoke? | **Tracing nativo** — el `graph.invoke` ya está instrumentado por LangGraph. No agregar wrappers manuales hasta H4. |
| 4 | ¿`oos` con baja confidence (<0.5) cae al social oos handler o pide reformular? | **Social oos** (más amable que "no entendí") |
| 5 | ¿`forward_message` requiere confirmación interactiva en H3.B? | **No** — implementarlo simple (sin gate) en H3.B; agregar confirmación en H5 cuando el patrón de gate esté validado en H4. |

---

## 8. Riesgos + mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Classifier alucina intents inexistentes | Media | Fail-open a `unknown` + `confidence` bajo → tratado como oos. |
| Heurística de keywords falsa positivos / negativos | Alta | Tests con corpus inicial de frases reales (cuando estén disponibles del piloto). Iterar. |
| `AnthropicProvider.complete` falla intermitente (rate limit) | Media | RetryClient no aplica acá (axios), el SDK Anthropic tiene su propio retry. Verificar config default; fallback a social texto genérico. |
| Tracing LangSmith fuga PII si HIDE_INPUTS no está en true | Media | `initLangSmith` ya warna en prod. Reforzar en runbook de deploy. |
| El placeholder subgraph confunde usuarios reales | Alta | Mensaje de placeholder debe ser explícito ("próximamente"). En pre-prod, mejor desactivar branches que ruteen a subgrafos no implementados. |

---

## 9. Referencias

- [`docs/REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §9 (LLM), §10 (supervisor + subgrafos), §11 (modelos), §13.6 (LangSmith)
- [`docs/SPRINT.md`](./SPRINT.md) H3 sección
- Memoria [[reference-langgraph-ts-spike]] — gotchas
- Memoria [[project-h3a-state-and-h3b-plan]] — checklist más conciso
