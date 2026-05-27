# Plan H4 — Subgrafo `schedule_appointment`

> Plan detallado de implementación del subgrafo más complejo del agente. Es el **validador del diseño completo** (state, interrupts, anti-alucinación, gate de confirmación, recovery de race conditions). El patrón establecido acá se reusa en H5–H7.
>
> Pre-requisitos: H3 completo (supervisor LLM + tools atómicas + button shortcuts). Idealmente P1 desplegado en Guacuco (idempotency keys); se puede arrancar sin él, pero el commit final del subgrafo lo necesita para protección anti-doble-creación.
>
> Documento canónico para H4. Cualquier divergencia debe actualizar este archivo.

---

## 0. Contexto

El subgrafo recibe el control cuando el supervisor clasifica intent = `schedule`. Su trabajo:

1. Recopilar los slots necesarios (service, staff, date, time) — multi-turno con `interrupt()` cuando algo falta.
2. Validar disponibilidad real contra Guacuco (`/tools/validate` con `tool_name='schedule_appointment'`).
3. Si hay alternativas (slot pedido no disponible), presentar lista al usuario.
4. Pedir confirmación explícita antes del side-effect.
5. Crear el turno via Guacuco `/tools/execute` con `idempotency_key`.
6. Devolver outcome al supervisor.

**Reglas duras** (heredadas de [`REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §8/§9/§10):

- El LLM **NO escribe** UUIDs ni `date.value`/`time.value` finales. Solo `resolve_entities` (fuzzy match local) y `parseUserSlotReply` (puro) lo hacen.
- El nodo `commit` es **función pura** — no tool ReAct. Lee del state directo. No hay agente decidiendo en el último paso.
- `requiresConfirmation = true` por default para `schedule_appointment`. El gate va antes del commit, no después.
- Side-effect en Guacuco solo ocurre en el nodo `commit`. Todo lo previo es draft checkpointeado.

---

## 1. State del subgrafo: `AppointmentDraftState`

### 1.1 Shape completo

```typescript
export interface SlotState<TValue> {
  value?: TValue;
  /** Lo que dijo el usuario en su mensaje (texto crudo). Útil para echo en mensajes confirmatorios. */
  userPhrase?: string;
  /** Display name para mostrar al LLM en build_confirm_message (NUNCA UUIDs). */
  displayName?: string;
  status: 'empty' | 'guessed' | 'resolved';
}

export interface AppointmentDraftState {
  /** Slots requeridos. service_uuids es plural porque Guacuco lo soporta. */
  slots: {
    services: SlotState<string[]>;     // value = service_uuids[]; displayName = "corte + barba"
    staff: SlotState<string>;          // value = staff_uuid
    date: SlotState<string>;           // value = YYYY-MM-DD
    time: SlotState<string>;           // value = HH:mm
    /** Solo presente cuando profileType=staff agendando para tercero. */
    clientUuid?: SlotState<string>;
  };

  /** Cache de la última llamada a Guacuco /tools/validate. */
  availability: {
    /** Snapshot de los slot values en el momento del check. Si los slots cambian, este cache se invalida. */
    lastCheckedFor?: {
      date: string;
      time: string;
      staffUuid: string;
      serviceUuids: string[];
    };
    /** True si Guacuco confirmó que ese slot exacto está disponible. */
    exactMatch?: boolean;
    /** Sugerencias devueltas por Guacuco (suggestions.combined o slot.date/time). */
    proposedSlots: Array<{
      date: string;
      time: string;
      label: string;  // "4 de marzo - 10:00", ya formateado por Guacuco
    }>;
  };

  /** Gate de confirmación. Set por gate_confirm antes de interrupt(). */
  confirmation: {
    /** UUID único del intento. Previene taps stale en button payloads (§21.6 IDP v2). */
    intentUuid?: string;
    /** Texto formulado por LLM (cacheado para sobrevivir re-taps / re-deserializaciones). */
    message?: string;
    /** ISO8601 timestamp para observabilidad. */
    requestedAt?: string;
  };

  /** Status del subgrafo (no del LLM). Usado por nodos del propio subgrafo para routing. */
  phase:
    | 'collecting'           // Recopilando slots
    | 'resolving_entities'   // resolve_entities corriendo
    | 'validating_availability'
    | 'awaiting_pick'        // present_options pidió selección al usuario
    | 'awaiting_confirmation'// gate_confirm esperando tap
    | 'committing'           // commit() en vuelo
    | 'done'
    | 'failed';

  /** Guard anti-loop. Incrementado por ask_slot. Si supera N → handed_off. */
  meta: {
    attempts: number;
    recoverableErrors: string[];  // backend codes para análisis post-mortem
  };
}
```

### 1.2 Reducers por campo

`Annotation.Root` no se usa para `subgraphState` directamente — el state global lo trata como `unknown` con `replaceWith` (ver `src/graph/state.ts`). El subgrafo opera con un sub-`StateGraph` propio que tiene sus reducers internos:

| Field | Reducer | Notas |
|---|---|---|
| `slots.services` | `replaceWith` por slot | Set por `resolve_entities` o `parseUserSlotReply` (cuando es lista de IDs ya elegida). |
| `slots.staff` | `replaceWith` por slot | Idem. |
| `slots.date` | `replaceWith` por slot | Set por `parseUserSlotReply` (función pura). |
| `slots.time` | `replaceWith` por slot | Idem. |
| `slots.clientUuid` | `replaceWith` por slot | Solo cuando rol=staff. |
| `availability` | `replaceWith` (cuando re-validamos limpia el cache anterior); reducer custom para invalidar cuando cambian slots críticos. | Ver sección 3.9 (cambio mid-confirm). |
| `confirmation` | `replaceWith` | Set por `gate_confirm`, limpiado por `cancel implícito` o tras commit. |
| `phase` | `replaceWith` | Único campo de coordinación entre nodos del subgrafo. |
| `meta.attempts` | reducer `(curr, next) => curr + next` (suma) | Para que cada nodo pueda `return { meta: { attempts: 1 } }` sin conocer el actual. |
| `meta.recoverableErrors` | append | Para auditoría. |

### 1.3 Ownership (qué nodo escribe qué)

| Field | Único mutador |
|---|---|
| `slots.services.value` (uuids) | `resolve_entities` |
| `slots.staff.value` (uuid) | `resolve_entities` |
| `slots.date.value` (YYYY-MM-DD) | `parseUserSlotReply` (helper puro invocado por nodos de ingestión) |
| `slots.time.value` (HH:mm) | `parseUserSlotReply` |
| `slots.*.displayName` | `resolve_entities` (lo que devolvió Guacuco fuzzy match) |
| `availability` | `validate_availability` |
| `confirmation.*` | `gate_confirm` (set), `cancel_handler` (clear) |
| `phase` | nodos del subgrafo (cada uno setea su transición) |
| `meta.attempts` | `ask_slot` (incrementa al pedir) |

**El LLM nunca escribe los valores finales.** Los nodos LLM (`ask_slot`, `build_confirm_message`, `present_options`, `interpret_user_reply`) producen texto para el usuario o llaman helpers determinísticos.

---

## 2. Mapa del subgrafo

### 2.1 Diagrama

```
                       ┌──────────────────┐
                       │  entry           │  pre-fill desde NLU del supervisor
                       └────────┬─────────┘
                                │
                       ┌────────▼──────────┐
                       │ resolve_entities  │  fuzzy match local sobre helpersLists
                       └────────┬──────────┘  (determinístico, NO LLM)
                                │
                       ┌────────▼─────────────┐
                       │ check_completeness   │  función pura
                       └─┬──────────────────┬─┘
                missing │                  │ all required resolved
                        │                  │
              ┌─────────▼─────────┐        │
              │ ask_slot          │        │
              │ (LLM + interrupt) │        │
              └─────────┬─────────┘        │
                        │ user reply       │
              ┌─────────▼──────────────┐   │
              │ interpret_user_reply   │   │
              │ (parseUserSlotReply,   │   │
              │  resolve_entities)     │   │
              └─────────┬──────────────┘   │
                        │                  │
                        └──────────────────┘
                                │
                       ┌────────▼─────────────┐
                       │ validate_availability│  Guacuco /tools/validate
                       │  (con appointment_uuid│  → exactMatch + suggestions
                       │   omitido en schedule)│
                       └─┬──────────────────┬─┘
            exact match  │                  │ no match
                         │                  │
              ┌──────────▼───────┐  ┌───────▼─────────────┐
              │ build_confirm    │  │ present_options     │
              │ message (Haiku)  │  │ (LLM + interrupt    │
              └──────────┬───────┘  │  list de WhatsApp)  │
                         │          └─────────┬───────────┘
              ┌──────────▼───────┐            │ user picks
              │ gate_confirm     │            │
              │ (interrupt +     │  ┌─────────▼──────────────┐
              │  button payload) │  │ apply_proposed_slot    │
              └────┬──────────┬──┘  │ (función pura: copia   │
        confirm    │          │     │  date/time del slot    │
                   │          │ cancel│  elegido al state)   │
        ┌──────────▼──────┐   │      └─────────┬─────────────┘
        │ commit          │   │                │
        │ (Guacuco        │   │                └──────► build_confirm
        │  /tools/execute,│   │
        │  idempotency_key│   │
        │  = intentUuid)  │   │
        └──────┬──────┬───┘   │
   success    │      │ STAFF_NOT_AVAILABLE
              │      │ (race)
              │      └──► validate_availability (loop)
              │
   ┌──────────▼───────┐    ┌────────────────────┐
   │ success_response │    │ cancel_handler     │
   │ (Haiku short)    │    │ (clean confirm,    │
   └──────┬───────────┘    │  preserve slots)   │
          │                └────────┬───────────┘
          │                         │ free-text del usuario
          │                         │
          │                         └──► ask_slot
   ┌──────▼──┐
   │  EXIT   │ outcome al supervisor
   └─────────┘
```

### 2.2 Descripción por nodo

| Nodo | Tipo | Rol | Lee | Escribe |
|---|---|---|---|---|
| `entry` | Determinístico | Pre-fill desde entidades NLU del supervisor (si las hay). Setea `phase='resolving_entities'`. | `state.input`, `state.identity` | `slots.*.userPhrase`, `slots.*.status='guessed'`, `phase` |
| `resolve_entities` | Determinístico (puede llamar Guacuco para nombres complejos, pero default es local) | Convierte `userPhrase` → `value` + `displayName`. Fuzzy match LOCAL sobre `state.crmContext.helpersLists` (que vino en `identity` resolve). | `slots.*.userPhrase`, `state.crmContext.helpersLists` | `slots.*.value`, `slots.*.displayName`, `slots.*.status='resolved'` |
| `check_completeness` | Determinístico puro | Decide si faltan slots required. Retorna decisión, no muta state. | `slots.*`, `state.identity.profileType` (para clientUuid) | — |
| `ask_slot` | LLM (Haiku) | Pregunta el slot faltante al usuario. Llama `interrupt()`. Incrementa `meta.attempts`. | slots resueltos para contexto, `meta.attempts` | `phase='collecting'`, `meta.attempts++` |
| `interpret_user_reply` | Determinístico (calls `parseUserSlotReply`, optionally re-runs `resolve_entities`) | Toma el texto del usuario reanudado y lo mapea a slot(s). | resume payload, `slots` actual | `slots.*` |
| `validate_availability` | Determinístico (calls Guacuco) | Llama `guacuco.validateScheduleSlot(...)`. Popula `availability`. | `slots.services/staff/date/time/.value`, `state.identity.tenantAlliaId` | `availability.lastCheckedFor`, `availability.exactMatch`, `availability.proposedSlots` |
| `availability_router` | Determinístico (conditional edge) | Routes según `exactMatch`. | `availability.exactMatch` | — |
| `present_options` | LLM (Haiku, mínimo) + `interrupt()` | Construye list message con los `proposedSlots`. IDs `slot_pick:<idx>`. | `availability.proposedSlots` | `phase='awaiting_pick'` |
| `apply_proposed_slot` | Determinístico puro | Después del pick: copia `date` + `time` del proposedSlot[idx] a los slots. | resume payload (`slot_pick:<idx>`), `availability.proposedSlots` | `slots.date.value`, `slots.time.value`, `availability.exactMatch=true` |
| `build_confirm_message` | LLM (Haiku, temp 0.3, max 120 tokens) | Genera mensaje confirmatorio. Recibe solo `displayName`s y `value`s renderizados, NUNCA UUIDs. | `slots.*.displayName/value` | `confirmation.message` (cache), `confirmation.intentUuid` (uuid()), `confirmation.requestedAt` |
| `gate_confirm` | Determinístico + `interrupt()` | Emite buttons `confirm:<intentUuid>` / `cancel:<intentUuid>` + interrupt. | `confirmation.message`, `confirmation.intentUuid` | `phase='awaiting_confirmation'` |
| `confirm_handler` | Determinístico (conditional edge) | Match del payload contra `confirmation.intentUuid`. Routes a `commit` o `cancel_handler`. | resume payload, `confirmation.intentUuid` | — |
| `commit` | Determinístico (función pura + Guacuco call) | Llama `guacuco.scheduleAppointment({...slots.value}, {idempotencyKey: confirmation.intentUuid})`. Assertion previa: `status==='resolved'` en todos los slots required. | `slots.*.value`, `state.identity.profileUuid` (como client_uuid si role=client), `state.identity.tenantAlliaId`, `confirmation.intentUuid` | `phase='done'`, `outcome` |
| `success_response` | LLM (Haiku, max 100 tokens) | Genera confirmación corta al usuario. Recibe el `appointmentUuid` solo para inclusión opcional, no para echo. | `slots.*.displayName`, commit result | `outcome.pendingReply` |
| `cancel_handler` | Determinístico puro | Limpia `confirmation.*`, deja `slots` intactos, `phase='collecting'`. Retorna al usuario al loop con free-text. | — | `confirmation`, `phase`, `availability` (invalidate cache si aplica) |
| `error_handler` | Determinístico | Maneja errores recuperables vs no recuperables del commit. Recoverable (race) → vuelve a `validate_availability`. No recoverable → `phase='failed'`, outcome handed_off. | error code, `meta.recoverableErrors` | `phase`, `meta.recoverableErrors[...err]`, `outcome` |

---

## 3. Flujos concretos

### 3.1 Happy path turno único

Cliente escribe: *"Quiero un turno para corte mañana a las 4 con María"*.

```
Supervisor clasifica intent='schedule' → invoca subgrafo
entry: pre-fill {services:'corte', staff:'María', date:'mañana', time:'4'} todos status='guessed'
resolve_entities (paralelo):
  services: fuzzy match 'corte' en helpersLists → service_uuid='svc-1', displayName='Corte'. Status='resolved'.
  staff: 'María' → staff_uuid='stf-1', displayName='María García'. Status='resolved'.
  date: parseUserSlotReply('mañana', timezone) → '2026-05-28'. Status='resolved'.
  time: parseUserSlotReply('4') → '16:00' (heurística horario comercial). Status='resolved'.
check_completeness: todos resolved → validate_availability
validate_availability: Guacuco POST /tools/validate {tool_name:'schedule_appointment', parameters:[date,appointment_time], context:{...}}
  → response {valid:true, results:[...]} → exactMatch=true, proposedSlots=[] (no hay alternativas necesarias)
availability_router: exactMatch=true → build_confirm_message
build_confirm_message: Haiku produce "Voy a agendar tu corte con María García el jueves 28 de mayo a las 16:00. ¿Confirmás?"
  Cache en confirmation.message. confirmation.intentUuid = uuid().
gate_confirm: interrupt() con buttons [Confirmar (id=confirm:<uuid>), Cancelar (id=cancel:<uuid>)]
[FIN DEL TURNO 1]

[TURNO 2: usuario tapea Confirmar]
Supervisor reconoce prefijo confirm: → invoca subgrafo con Command(resume=payload)
confirm_handler: payload.id === `confirm:${confirmation.intentUuid}` → commit
commit:
  assertion: slots.services.status==='resolved' && slots.staff.status==='resolved' && slots.date.status==='resolved' && slots.time.status==='resolved'
  llama guacuco.scheduleAppointment({
    business_allia_id: state.identity.tenantAlliaId,
    date: slots.date.value,
    appointment_time: slots.time.value,
    client_uuid: state.identity.profileUuid,
    staff_uuid: slots.staff.value,
    service_uuids: slots.services.value
  }, { idempotencyKey: confirmation.intentUuid })
  → response 201 con appointment_uuid='apt-XYZ'
success_response: Haiku produce "✅ Turno agendado el jueves 28 a las 16:00 con María García. Te esperamos!"
EXIT con outcome.action='response', pendingReply.text='...'
```

### 3.2 Slot faltante (multi-turn con `interrupt`)

Cliente: *"Quiero un turno"*.

```
entry: slots todos empty
resolve_entities: nada que resolver
check_completeness: faltan services, staff, date, time
ask_slot decide qué pedir según granularidad acordada (§10.4 REGLAS):
  1ro pide service (aislado, list message): "¿Qué servicio querés?" con list de servicios.
  interrupt() con interactive list.
[FIN TURNO 1]

[TURNO 2: usuario tapea "Corte" del list]
supervisor → button shortcut detecta slot_pick: (genérico) o list reply → invoca subgrafo
interpret_user_reply: payload.id = 'slot:corte' (o el ID que setteó ask_slot)
  parseUserSlotReply('Corte', context) o lookup directo por ID → slots.services.value=['svc-1']. Status='resolved'.
check_completeness: faltan staff, date, time
ask_slot: pide staff con list message.
[FIN TURNO 2]

[TURNO 3: usuario elige "María"]
interpret_user_reply: slots.staff.value='stf-1'. Status='resolved'.
ask_slot: pide date + time JUNTOS (texto libre).
"¿Para cuándo? Decime día y hora."
[FIN TURNO 3]

[TURNO 4: usuario "el jueves a las 4"]
interpret_user_reply: parseUserSlotReply parsea ambos.
slots.date.value='2026-05-28', slots.time.value='16:00'. Status='resolved'.
check_completeness: completo → validate_availability → ... (resto idéntico a 3.1)
```

### 3.3 Slot no disponible (sugerencias)

Misma situación que 3.1 pero `validate_availability` retorna `valid=false` con `suggestions.combined=['2026-05-28 17:00', '2026-05-28 18:00', '2026-05-29 10:00']`.

```
availability_router: exactMatch=false → present_options
present_options: Haiku produce body "El horario que pediste no está disponible. Estos son los próximos:"
  list message con 3 rows: "28 mayo - 17:00", "28 mayo - 18:00", "29 mayo - 10:00", IDs slot_pick:0/1/2
  availability.proposedSlots cacheado en state.
  interrupt()
[FIN TURNO]

[TURNO siguiente: usuario tapea slot_pick:1]
apply_proposed_slot: slots.date.value='2026-05-28', slots.time.value='18:00'. availability.exactMatch=true.
NO se re-valida (Guacuco mismo nos dio la opción).
build_confirm_message → gate_confirm → ... (igual a 3.1 desde acá)
```

### 3.4 Race en commit (recovery)

Confirmado el slot. `commit` llama Guacuco. Otro cliente lo tomó entre check y commit.

```
commit: guacuco.scheduleAppointment → ToolExecutionError(code='STAFF_NOT_AVAILABLE', message='slot taken')
error_handler: code === 'STAFF_NOT_AVAILABLE' → recoverable
  state updates:
    availability.exactMatch=false (invalida cache)
    confirmation = {} (limpia gate previo)
    meta.recoverableErrors.push('STAFF_NOT_AVAILABLE')
  Route → validate_availability (re-fetch sugerencias actualizadas)
validate_availability → suggestions actualizadas (puede que ahora haya otras opciones).
present_options con nuevas opciones.
[continúa flujo normal]
```

Otros códigos manejados acá:
- `IDEMPOTENT_REQUEST_IN_PROGRESS` (spec P1): no-recoverable inmediato; back-off + retry una vez; si falla otra vez → handed_off.
- `BUSINESS_MISMATCH`: no-recoverable. `phase='failed'`, outcome `error`. Log + Sentry.

### 3.5 Cancel implícito mid-confirm

Estado: `phase='awaiting_confirmation'`, gate activo.

Usuario manda texto libre: *"mejor a las 17"*.

```
Supervisor recibe el mensaje. button shortcut NO matchea (no es 'confirm:*' ni 'cancel:*').
Supervisor classifyIntent → 'action' (no greeting/farewell/oos).
Supervisor decisión: hay subgrafo activo + state.subgraphState.phase='awaiting_confirmation' → invoca subgrafo con Command(resume) PERO con payload de texto, no de button.

Subgrafo reanuda en gate_confirm (que era el último nodo con interrupt).
gate_confirm tras resume: lee el payload. Si es payload.kind === 'text' (no button) → llama cancel_handler.

cancel_handler:
  confirmation = {} (limpia)
  availability.exactMatch = undefined (invalida cache porque slot puede cambiar)
  phase = 'collecting'
  Slots SE PRESERVAN. Quizá invalidar slot.time si el usuario propuso uno nuevo.

interpret_user_reply: parseUserSlotReply('mejor a las 17', context) → slots.time.value='17:00'.
check_completeness: completo → validate_availability con nuevo time.
... (loop normal)
```

### 3.6 Multi-service

Cliente: *"Corte y barba mañana a las 4 con María"*.

```
entry: slots.services.userPhrase = 'corte y barba'
resolve_entities: fuzzy match split por 'y' / 'mas' / coma → ['Corte', 'Barba']
  → slots.services.value = ['svc-corte', 'svc-barba']
  → displayName = 'Corte + Barba'
validate_availability: pasa service_uuids=['svc-corte','svc-barba']. Guacuco calcula duración total automáticamente (handler de Guacuco hace eso).
Resto idéntico.
```

### 3.7 Identity dual (staff agendando para cliente)

`state.identity.profileType === 'staff'` → `check_completeness` requiere `slots.clientUuid` adicional.

```
entry: si hay un client mencionado en el mensaje (entidad NLU), pre-fill slots.clientUuid.userPhrase.
resolve_entities para clientUuid: fuzzy match en CRM (Parguito) o búsqueda por phone/name.
  ESTO requiere endpoint Guacuco/Parguito de búsqueda de cliente. Si no existe, ask_slot con list de clientes recientes.
  Para v1: si Parguito no expone búsqueda, ask_slot con texto libre "¿Para qué cliente?" + el staff usa CRM por separado.
  → POST-V1: integrar búsqueda inteligente.

resto idéntico, solo que el commit pasa client_uuid = slots.clientUuid.value (no state.identity.profileUuid).
```

### 3.8 Guard anti-loop

`ask_slot` incrementa `meta.attempts`. Si supera N (default 5) → outcome handed_off con razón.

```
ask_slot pre-check:
  if (state.meta.attempts > MAX_ATTEMPTS) {
    return { phase: 'failed', outcome: { action: 'handed_off', pendingReply: { text: 'No pude completar el agendamiento. Un humano te va a contactar.' } } }
  }
```

Pasa cuando: usuario no entiende, NLU falla repetidamente, ambigüedad insalvable.

### 3.9 Cambio de slot mid-confirm

Cubierto por 3.5. Clave: el reducer del availability tiene que invalidarse cuando cambia un slot. Implementación: en lugar de un reducer "smart", el nodo `interpret_user_reply` retorna `{slots: {...}, availability: {...empty}}` explícitamente para limpiar.

---

## 4. Anti-alucinación: implementación

### 4.1 Tabla de defensas (heredada de [`REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §9)

| Defensa | Implementación en H4 |
|---|---|
| `commit` es función pura, no tool LLM | El nodo `commit` es código TS. Llama directamente `guacuco.scheduleAppointment(...)`. No hay `tool_use` del LLM. |
| Valores críticos vienen del state, no del LLM | `commit` lee `state.slots.*.value`, `state.identity.profileUuid`, `state.identity.tenantAlliaId`. Cero llamadas a interpretación LLM en este punto. |
| `resolve_entities` único autorizado para nombres→UUIDs | Centralizado. Fuzzy match sobre `helpersLists` local. LLM nunca asigna `uuid` directamente. |
| `parseUserSlotReply` único helper para date/time | Función pura en `src/graph/nodes/parseUserSlotReply.ts`. Testeable independiente. Acepta zonas horarias del state.identity. |
| `status==='resolved'` como gate de `commit` | `commit` empieza con `assertSlotsResolved(state)` que lanza `IdpError('invariant_violated', 'slot not resolved')`. |

### 4.2 `assertSlotsResolved`

```typescript
// src/graph/subgraphs/schedule/assertions.ts
import { IdpError } from '../../../core/errors/IdpError.js';
import type { AppointmentDraftState } from './state.js';

export function assertSlotsResolved(
  state: AppointmentDraftState,
  required: Array<keyof AppointmentDraftState['slots']>,
): void {
  for (const key of required) {
    const slot = state.slots[key];
    if (!slot) {
      throw new IdpError('invariant_violated', `Required slot missing in state: ${key}`);
    }
    if (slot.status !== 'resolved') {
      throw new IdpError('invariant_violated', `Slot ${key} not resolved before commit`, {
        status: slot.status,
        hasValue: 'value' in slot && slot.value !== undefined,
      });
    }
    if (slot.value === undefined || slot.value === null) {
      throw new IdpError('invariant_violated', `Slot ${key} resolved but value missing`);
    }
  }
}
```

Usado en el nodo `commit` antes de cualquier llamada a Guacuco. Y testeado explícitamente como caso #6 de los críticos.

### 4.3 Lo que el LLM SÍ produce (whitelist)

| Producto LLM | Nodo | Contenido |
|---|---|---|
| Texto de pregunta de slot faltante | `ask_slot` | "¿Qué servicio querés?" — sin valores específicos |
| Texto del mensaje confirmatorio | `build_confirm_message` | "Voy a agendar tu corte..." — recibe SOLO displayNames + values renderizados (fecha legible, hora HH:mm) |
| Lista de opciones | `present_options` | Body text que precede al list. La list SE CONSTRUYE DETERMINÍSTICAMENTE desde `availability.proposedSlots`. |
| Mensaje de éxito | `success_response` | "Turno agendado..." — recibe displayName + fecha/hora legibles |
| Mensaje de error amigable | `error_handler` | "Hubo un problema..." |

**Nunca** produce UUIDs, fechas crudas, números de teléfono.

---

## 5. Confirmación + interrupts

### 5.1 `intentUuid`

Generado por `build_confirm_message` (`uuid()`). Persistido en `state.confirmation.intentUuid` cuando se entra al gate.

**Por qué importa**: previene taps stale. Escenarios:
- Usuario tapea "Confirmar" mucho después → la sesión ya tuvo otro gate → el `intentUuid` no matchea → se rechaza el tap.
- Usuario tapea "Confirmar" después de que se hizo otro schedule → idem.
- Doble-tap del usuario por flake → primera matchea, segunda no (porque `confirmation` se limpia tras commit).

### 5.2 Estructura del button payload

```
"confirm:<intentUuid>"
"cancel:<intentUuid>"
"slot_pick:<idx>"  ← para present_options
```

El supervisor reconoce el prefijo y bypasea el LLM (atajo determinístico — H3.B).

### 5.3 Gotcha LangGraph: `interrupt()` re-runs node from top

Según el spike: cuando un nodo llama `interrupt()` y luego es reanudado con `Command(resume=...)`, **el nodo se re-ejecuta desde el principio**. Todo código pre-interrupt se ejecuta de nuevo.

**Implicaciones para H4**:

- `gate_confirm` debe ser **idempotente** en su parte pre-interrupt. Como `confirmation.intentUuid` ya está en el state (set por `build_confirm_message` que corrió antes), re-ejecutar `gate_confirm` no genera un uuid nuevo. ✅
- `build_confirm_message` corre en un nodo separado. NUNCA hacer `confirmation.intentUuid = uuid()` dentro de `gate_confirm` (causaría regenerar el uuid en cada resume).
- `ask_slot` también debe ser idempotente en pre-interrupt. `meta.attempts++` es problemático si re-corre — lo que se hace: el incremento se hace **antes** de la decisión de pedir, y se persiste pre-interrupt. El re-run no duplica porque el state ya tiene el valor incrementado.

### 5.4 Cancel implícito

Si el usuario manda free-text mientras `phase='awaiting_confirmation'`:

- El supervisor lo invoca igual al subgrafo con `Command(resume=...)` pero con payload de texto.
- `gate_confirm` tras resume detecta `payload.kind === 'text'` (no es button) → routes a `cancel_handler`.
- `cancel_handler` limpia `confirmation` + invalida `availability`. Slots preservados.
- Loop continúa: `interpret_user_reply` toma el texto, lo mapea a slot updates, sigue.

---

## 6. Integración con supervisor

### 6.1 Entry desde supervisor

Supervisor en H3.B decide si rutea a `schedule`. Cuando lo hace:

```typescript
// supervisor.routeToSubgraph
return {
  routing: { activeSubgraph: 'schedule' },
  subgraphState: initialAppointmentDraftState(state),
};
```

`initialAppointmentDraftState` es función pura que arma el shape inicial con slots empty + meta.attempts=0 + phase='resolving_entities'. Si NLU del supervisor extrajo entidades, las copia como `userPhrase` con `status='guessed'`.

### 6.2 Exit hacia supervisor

Cuando el subgrafo termina (success, error, handed_off, cancelled):

- Setea `outcome` en el state global.
- Limpia `subgraphState = null`.
- Setea `routing.activeSubgraph = null`.

El supervisor en el siguiente turno (si lo hay) ve `routing.activeSubgraph === null` → arranca clasificación fresh.

### 6.3 Cambio de intent mid-flow

Si en un turno con `routing.activeSubgraph='schedule'` el usuario dice "mejor cancelo el otro turno", el supervisor:

- Corre clasificación primero (siempre, §10.2 REGLAS).
- Si classify detecta intent distinto (`cancel`) con alta confianza → setea `routing.handoff='user_changed_intent'`, descarta `subgraphState`, rutea a `cancel` subgrafo (H5).

El subgrafo `schedule` no se entera — su state simplemente fue descartado en el reducer.

---

## 7. Filtrado por rol

| Variante | Cliente | Staff |
|---|---|---|
| Slots requeridos | `services`, `staff`, `date`, `time` | `services`, `staff`, `date`, `time`, `clientUuid` |
| `client_uuid` en commit | `state.identity.profileUuid` (siempre) | `state.subgraphState.slots.clientUuid.value` (slot adicional) |
| Resolución de `clientUuid` | N/A | `resolve_entities` con búsqueda CRM (Parguito) o `ask_slot` con texto libre |

`check_completeness` toma `state.identity.profileType` como input. Si `staff` y `clientUuid` empty → falta slot.

---

## 8. Tests críticos (los 10 casos del SPRINT)

Cada caso es un test individual en `tests/unit/graph/subgraphs/schedule/`. Mockeo de `GuacucoClient` + `AnthropicProvider`.

| # | Caso | Lo que verifica |
|---|---|---|
| 1 | **Happy path** turno único | Cliente manda todo, commit OK, outcome=response con texto de éxito. |
| 2 | **Slot faltante** → ask → resolve → confirm → commit | 4 turnos. Verifica interrupt + resume + state persistence. |
| 3 | **Slot no disponible** → present_options → user picks → confirm → commit | 3 turnos. Verifica suggestions cache + apply_proposed_slot. |
| 4 | **Race en commit** (`STAFF_NOT_AVAILABLE`) | error_handler vuelve a validate_availability, no rompe. |
| 5 | **Cancel implícito mid-confirm** (usuario manda texto libre) | confirmation limpiado, slots preservados, re-validate con nuevo time. |
| 6 | **Anti-alucinación** — commit con slot no resuelto | `assertSlotsResolved` lanza `IdpError('invariant_violated')`. |
| 7 | **Guard anti-loop** — `meta.attempts > MAX` | outcome=handed_off, no infinite loop. |
| 8 | **Multi-service** (`service_uuids` con 2+ elementos) | resolve_entities split correcto, commit pasa array. |
| 9 | **Cambio de slot mid-confirm** ("mejor a las 17") | reducer invalida availability + confirmation, re-valida. |
| 10 | **Identity dual** — staff agenda para cliente | Slot extra clientUuid, commit pasa correcto `client_uuid`. |

Cada test sigue patrón:
1. Setup state inicial + mocks.
2. Invoke subgrafo turno 1.
3. Verifica state intermedio (interrupt expected, slots, phase).
4. Reanuda con payload.
5. Verifica state final + llamadas a Guacuco.

---

## 9. Plan de implementación (sub-hitos H4.x)

Cada sub-hito es committeable individualmente con tests verdes. Total: 6 sub-hitos.

### H4.1 — State + entry + resolve_entities

**Entregables**:
- `src/graph/subgraphs/schedule/state.ts`: `AppointmentDraftState` + reducers + `initialAppointmentDraftState`.
- `src/graph/subgraphs/schedule/nodes/entry.ts`: pre-fill desde NLU entities (recibidas del supervisor en `state.input` o agregadas como state inicial).
- `src/graph/subgraphs/schedule/nodes/resolveEntities.ts`: fuzzy match local sobre `state.crmContext.helpersLists` (cargado por el pre-grafo). Detalle de fuzzy match: normalize lowercase + accents-strip + Levenshtein <= 2 o substring match.
- `src/graph/nodes/parseUserSlotReply.ts`: helper puro para fechas/horas. Inputs: texto + timezone. Acepta:
  - Día relativo: hoy, mañana, pasado, ayer
  - Día de semana: lunes, martes, ... (próxima ocurrencia)
  - Fecha explícita: 15 de marzo, 15/03, 2026-03-15
  - Hora: HH:mm, "4", "4pm", "16hs", ventana ("por la tarde", "mañana")
- Tests: entry pre-fill, resolveEntities con casos varios, parseUserSlotReply con inputs degenerados.

**DoD**: typecheck + lint + tests para los 3 archivos. State persiste correctamente vía MemorySaver.

### H4.2 — Slot filling: check_completeness + ask_slot + interpret_user_reply

**Entregables**:
- `src/graph/subgraphs/schedule/nodes/checkCompleteness.ts`: función pura.
- `src/graph/subgraphs/schedule/nodes/askSlot.ts`: LLM nodo con `interrupt()`. Granularidad acordada (service aislado list, staff aislado list, date+time juntos texto libre, clientUuid si staff).
- `src/graph/subgraphs/schedule/nodes/interpretUserReply.ts`: tras resume, parsea payload (button id, list selection, text) y aplica al state usando `parseUserSlotReply` + `resolveEntities`.
- Tests: ciclo ask → resume → interpret para cada granularidad. Verificar idempotencia del nodo pre-interrupt.

**DoD**: typecheck + lint + tests. Demostrar interrupt + resume con MemorySaver.

### H4.3 — Validación de disponibilidad + present_options

**Entregables**:
- `src/graph/subgraphs/schedule/nodes/validateAvailability.ts`: llama `guacuco.validateScheduleSlot`. Popula `availability`.
- `src/graph/subgraphs/schedule/nodes/availabilityRouter.ts`: conditional edge.
- `src/graph/subgraphs/schedule/nodes/presentOptions.ts`: LLM + `interrupt()` con list message (max 10 rows). Cachea proposedSlots.
- `src/graph/subgraphs/schedule/nodes/applyProposedSlot.ts`: función pura. Tras pick, copia date/time al state.
- Tests: validateAvailability con exact match + no match, presentOptions con suggestions cap 10, applyProposedSlot.

**DoD**: typecheck + lint + tests. Demostrar flujo 3.3 (slot no disponible → pick → continúa).

### H4.4 — Confirmación: build_confirm_message + gate_confirm

**Entregables**:
- `src/graph/subgraphs/schedule/nodes/buildConfirmMessage.ts`: LLM Haiku temp 0.3 max 120. Recibe **SOLO** `displayName`s + fechas/horas renderizadas. Genera `confirmation.intentUuid` + `confirmation.message`.
- `src/graph/subgraphs/schedule/nodes/gateConfirm.ts`: `interrupt()` con buttons confirm:`<uuid>` / cancel:`<uuid>`. Sets `phase='awaiting_confirmation'`.
- `src/graph/subgraphs/schedule/nodes/confirmHandler.ts`: tras resume, match del button payload contra `confirmation.intentUuid`. Routes a commit o cancel_handler.
- `src/graph/subgraphs/schedule/nodes/cancelHandler.ts`: limpia confirmation + availability, preserva slots, `phase='collecting'`. Si vino con free-text, lo encadena a `interpret_user_reply`.
- Tests: confirmación happy path, cancel con button, cancel implícito con texto libre, intent_uuid stale rechaza.

**DoD**: typecheck + lint + tests. Verificar idempotencia de pre-interrupt en gate_confirm.

### H4.5 — Commit + success_response + error_handler

**Entregables**:
- `src/graph/subgraphs/schedule/assertions.ts`: `assertSlotsResolved` exportada para test directo.
- `src/graph/subgraphs/schedule/nodes/commit.ts`: assertion → `guacuco.scheduleAppointment(...)` con `idempotencyKey = confirmation.intentUuid`. Lee del state.
- `src/graph/subgraphs/schedule/nodes/successResponse.ts`: LLM Haiku max 100 tokens. Genera confirmación al usuario.
- `src/graph/subgraphs/schedule/nodes/errorHandler.ts`: maps backend codes a recoverable/no-recoverable. Recoverable → vuelta a validate_availability. No → handed_off.
- Tests: assertion lanza si slot no resolved, commit happy, race STAFF_NOT_AVAILABLE recovery, BUSINESS_MISMATCH no-recoverable.

**DoD**: typecheck + lint + tests. **Requiere P1 desplegado en Guacuco** para test de idempotency key (alternativamente: mock + comment de "validar contra real cuando P1 esté").

### H4.6 — Integración full subgrafo + tests críticos + wire supervisor

**Entregables**:
- `src/graph/subgraphs/schedule/compile.ts`: `compileScheduleSubgraph(deps): CompiledSubgraph` con todos los nodos y edges. Usa `StateGraph<AppointmentDraftState>`. Compose con shared keys (identity, crmContext) del parent.
- Actualizar `src/graph/compile.ts`: agregar subgrafo al StateGraph del supervisor. Conditional edge desde supervisor → schedule cuando `routing.activeSubgraph='schedule'`.
- Tests integración: los 10 casos críticos del SPRINT como tests E2E con MemorySaver.

**DoD**: los 10 tests críticos verdes. Update SPRINT.md y CLAUDE.md.

---

## 10. Gotchas LangGraph TS (recordatorios del spike)

1. **`interrupt()` re-ejecuta el nodo desde arriba al reanudar**. Todo lo pre-interrupt debe ser idempotente. Para H4: side effects (Guacuco calls, uuid generation) van en nodos separados pre-`gate_confirm`/pre-`ask_slot`.
2. **Múltiples `interrupt()` en un mismo nodo**: matcheo por índice. **Evitar**. Usar un nodo separado por cada interrupt.
3. **Subgraph + shared keys**: el parent debe declarar reducer para keys que comparte con el sub. Para H4: `outcome`, `routing`, `subgraphState` se comparten. Reducers en `state.ts` ya están.
4. **`checkpointer: true` en subgrafos NO soporta parallel tool calls**. H4 no usa fan-out. OK.
5. **Default per-invocation checkpoint** del subgrafo. Pasamos checkpointer al StateGraph del subgrafo igual que el parent.
6. **`langgraph.prebuilt` deprecated en 1.0**. No usar. Para tools, definir handlers propios.

---

## 11. Decisiones a fijar antes de codear

| # | Decisión | Recomendación |
|---|---|---|
| 1 | ¿`ask_slot` pide service+staff en mensajes separados o intenta inferir staff cuando hay solo 1 staff para ese service? | **Inferir si único** — usar `helpersLists` para detectar. Reduce 1 turno. |
| 2 | ¿`parseUserSlotReply` para "4" interpreta 16:00 (PM heurística) o pregunta? | **PM heurística** durante horario comercial; documentar. Si no, pregunta. |
| 3 | ¿Búsqueda de cliente para identity dual está disponible (staff agenda para cliente)? | Si Guacuco/Parguito no expone fuzzy match de cliente, **scope OUT de v1 de H4**: solo el cliente puede schedule para sí mismo. Staff usa otra interfaz (dashboard). Documentar. |
| 4 | ¿`MAX_ATTEMPTS` antes de handed_off? | **5**. Configurable por env si hace falta tunear. |
| 5 | ¿Cache de `availability` se invalida solo en cambio de slot, o también con tiempo (TTL corto, ej. 60s)? | **Solo en cambio de slot** para v1. TTL agregable después si race conditions persisten. |
| 6 | ¿Mostrar precio en confirmación? (`helpersLists` lo trae) | **Sí** cuando esté disponible — incrementa transparencia. Si Guacuco lo tiene como `null`, omitir. |

Resolver antes de H4.1.

---

## 12. Riesgos + mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| `parseUserSlotReply` interpreta mal frases ambiguas ("a las 4" → AM vs PM) | Media | Heurística + tests con corpus de frases comunes. Si falla, pedir confirmación con `displayName` legible en `build_confirm_message`. |
| LangGraph re-run pre-interrupt causa side effects duplicados | Media | Discipline: side effects (uuid, Guacuco calls) **siempre** en nodo separado pre-interrupt. Tests específicos. |
| Subgraph + parent shared keys colisionan | Baja | Reducer claramente definido en `state.ts`. Tests integración. |
| Race en commit más frecuente de lo esperado | Media | Recovery automático en `error_handler`. Si vuelve a fallar 2 veces seguidas → handed_off. |
| Identity dual scope creep (búsqueda CRM) | Alta | Scope OUT v1 si Guacuco no expone búsqueda. Documentar y mover a H4+. |
| Tests E2E lentos por MemorySaver state | Baja | MemorySaver es in-memory rápido. Si lento, optimizar. |

---

## 13. Referencias

- [`docs/REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) — §8 (anti-alucinación), §9 (state como fuente), §10 (supervisor + subgrafos)
- [`docs/SPRINT.md`](./SPRINT.md) — H4 sección con DoD
- [`docs/specs/P1-idempotency-keys.md`](./specs/P1-idempotency-keys.md) — idempotency en commit
- Memoria [[reference-guacuco-endpoints]] — shape de `/tools/validate` y `/tools/execute`
- Memoria [[reference-langgraph-ts-spike]] — gotchas de interrupts, channels, subgrafos
- Memoria [[project-overview]], [[project-stack-decisions]], [[project-state-and-pregraph]] — diseño base
