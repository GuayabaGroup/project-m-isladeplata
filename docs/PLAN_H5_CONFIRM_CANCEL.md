# Plan H5 — Subgrafos `confirm` + `cancel`

> Dos subgrafos derivados directos del patrón establecido en H4. Validan que el costo marginal de agregar un trámite nuevo es bajo cuando se reutilizan los building blocks correctos.
>
> Pre-requisitos: H4 committeado. Idealmente P1 desplegado en Guacuco (idempotency keys).

---

## 0. Contexto

Ambos subgrafos son single-slot (`appointment_uuid`) con diferencias claves:

| | `confirm_appointment` | `cancel_appointment` |
|---|---|---|
| Slots required | `appointment_uuid` | `appointment_uuid` |
| `requiresConfirmation` | **No** (la tool ES confirmatoria por sí misma; pedir confirmación para confirmar es redundante) | **Sí** (cancelar es destructivo; necesita gate) |
| Bootstrap pre-fill | Sí (si hay un único upcoming, asumir) | Sí (si hay un único upcoming, asumir; si hay varios, pedir cuál) |
| Side-effect Guacuco | `confirm_appointment` execute | `cancel_appointment` execute |
| Output user | "Confirmado tu turno X" | "Cancelado tu turno X" |

Comparten ~80% del código con H4 (state, entry, resolve_entities adaptado, ask_slot, gate_confirm en cancel, commit-pattern).

---

## 1. State del subgrafo

### `ConfirmDraftState` (confirm)

```typescript
export interface ConfirmDraftState {
  slots: {
    appointmentUuid: SlotState<string>;
  };
  phase: 'collecting' | 'committing' | 'done' | 'failed';
  meta: { attempts: number; recoverableErrors: string[] };
  // NO availability, NO confirmation (no hay gate)
}
```

### `CancelDraftState` (cancel)

```typescript
export interface CancelDraftState {
  slots: {
    appointmentUuid: SlotState<string>;
  };
  confirmation: {
    intentUuid?: string;
    message?: string;
    requestedAt?: string;
  };
  phase: 'collecting' | 'awaiting_confirmation' | 'committing' | 'done' | 'failed';
  meta: { attempts: number; recoverableErrors: string[] };
}
```

Igual a Confirm pero con `confirmation` adicional.

---

## 2. Mapa del subgrafo

### 2.1 `confirm` (sin gate)

```
entry → bootstrap_from_upcoming → check_completeness
                                       │
                       missing apt_uuid │ resolved
                                       │
                          ┌────────────▼──────────┐
                          │ ask_slot              │
                          │ (list de upcomings)   │
                          └────────────┬──────────┘
                                       │ user picks
                          ┌────────────▼──────────┐
                          │ apply_picked_apt      │
                          └────────────┬──────────┘
                                       │
                          ┌────────────▼──────────┐
                          │ commit                │
                          │ (Guacuco confirm_     │
                          │  appointment)         │
                          └────────────┬──────────┘
                                       │
                          ┌────────────▼──────────┐
                          │ success_response      │
                          └────────────┬──────────┘
                                       │
                                     EXIT
```

### 2.2 `cancel` (con gate)

```
entry → bootstrap_from_upcoming → check_completeness
                                       │
                       missing apt_uuid │ resolved
                                       │
                          ┌────────────▼──────────┐
                          │ ask_slot              │
                          └────────────┬──────────┘
                                       │ user picks
                          ┌────────────▼──────────┐
                          │ apply_picked_apt      │
                          └────────────┬──────────┘
                                       │
                          ┌────────────▼──────────┐
                          │ build_confirm_message │
                          │ (Haiku — "¿Cancelás   │
                          │  el turno X?")        │
                          └────────────┬──────────┘
                                       │
                          ┌────────────▼──────────┐
                          │ gate_confirm          │
                          │ (interrupt + buttons) │
                          └──────┬────────────┬───┘
                       confirm   │            │ cancel/free-text
                                 │            │
                       ┌─────────▼────────┐   │
                       │ commit           │   │
                       └─────────┬────────┘   │
                                 │            │
                       ┌─────────▼────────┐   │
                       │ success_response │   │
                       └─────────┬────────┘   │
                                 │            │
                                 │  ┌─────────▼──────┐
                                 │  │ cancel_handler │
                                 │  │ (loop a ask)   │
                                 │  └────────────────┘
                                 │
                               EXIT
```

---

## 3. Nodos compartidos con H4 (reuso)

| Nodo | De H4 | Modificación |
|---|---|---|
| `entry` | Sí | Diferente set de slots, lógica análoga. |
| `parseUserSlotReply` | Sí | Sin cambios. |
| `assertSlotsResolved` | Sí | Aplica a `appointmentUuid`. |
| `build_confirm_message` | Sí (cancel) | Prompt diferente ("¿Cancelás...?"). |
| `gate_confirm` | Sí (cancel) | Mismo patrón, distinto state machine. |
| `confirm_handler` | Sí (cancel) | Mismo match contra `intentUuid`. |
| `cancel_handler` | Sí (cancel) | Mismo patrón. |
| `error_handler` | Sí | Recoverable codes pueden diferir. |

Lo único nuevo: `bootstrap_from_upcoming`, `apply_picked_apt`, `commit` específico, `success_response` específico.

### 3.1 `bootstrap_from_upcoming`

Lee `state.crmContext.upcomingAppointments` (o `identity.profileData.appointments`):

- 0 upcomings → `outcome={action: 'handed_off', text: 'No tenés turnos próximos para confirmar/cancelar'}` → EXIT.
- 1 upcoming → pre-fill `slots.appointmentUuid.value = upcoming[0].uuid`, status='resolved' (con `userPhrase='your only upcoming'`).
- 2+ upcomings → status='empty', `ask_slot` los lista con `description` (fecha + servicio).

### 3.2 `ask_slot` (variante)

Lista los upcomings como list message:
```
"¿Cuál querés [confirmar/cancelar]?"
- 4 marzo 10:00 - Corte con María
- 11 marzo 16:00 - Color con Pedro
```

IDs `apt_pick:<uuid>` (el uuid es el `appointment_uuid` real, no idx — más simple).

### 3.3 `apply_picked_apt`

Función pura: copia el `appointment_uuid` del pick al slot.

### 3.4 `commit` (cancel)

```typescript
async function commitCancel(state: CancelState, deps): Promise<GraphStateUpdate> {
  assertSlotsResolved(state, ['appointmentUuid']);
  await deps.guacuco.cancelAppointment(
    { appointment_uuid: state.slots.appointmentUuid.value! },
    { idempotencyKey: state.confirmation.intentUuid },
  );
  return { phase: 'done', outcome: {...} };
}
```

`commit` (confirm) es análogo con `confirmAppointment`. **No usa `idempotencyKey`** porque la tool es idempotente por construcción (confirmar 2 veces el mismo appointment es no-op en Guacuco). Pero pasarlo igual no hace daño — mejor consistencia: **pasarlo siempre**, usando un uuid generado al boot del subgrafo (no necesita gate uuid).

### 3.5 `success_response`

Respuesta corta Haiku:

- Confirm: "Confirmado: {service} con {staff} el {date} a las {time}. Te esperamos."
- Cancel: "Cancelado: {service} del {date} a las {time}. Si querés reprogramar, decímelo."

Solo `displayName`s, fechas/horas legibles. Cero UUIDs.

---

## 4. Anti-alucinación

Idéntica a H4 (§4 del PLAN_H4):

- `commit` es función pura.
- `appointment_uuid` viene del state, no del LLM. Solo se asigna por:
  - `bootstrap_from_upcoming` (lookup directo)
  - `apply_picked_apt` (lookup directo desde lista que vino de Guacuco)
- `assertSlotsResolved` antes de commit.

LLM solo produce textos de pregunta y de confirmación/respuesta (sin UUIDs en el prompt visible — el LLM puede ver el `description` legible del upcoming).

---

## 5. Plan de implementación (sub-hitos)

### H5.1 — `confirm_appointment`

| Entregable | Detalle |
|---|---|
| `src/graph/subgraphs/confirm/state.ts` | `ConfirmDraftState` + reducers |
| `src/graph/subgraphs/confirm/nodes/*.ts` | entry, bootstrap_from_upcoming, ask_slot, apply_picked_apt, commit, success_response, error_handler |
| `src/graph/subgraphs/confirm/compile.ts` | Compila + edges |
| `src/graph/compile.ts` | Wire en supervisor (reemplaza placeholder de H3.B) |
| Tests | 5 críticos: 0/1/N upcomings, happy commit, race recovery, anti-alucinación, anti-loop |

### H5.2 — `cancel_appointment`

| Entregable | Detalle |
|---|---|
| `src/graph/subgraphs/cancel/state.ts` | `CancelDraftState` |
| `src/graph/subgraphs/cancel/nodes/*.ts` | Como confirm + build_confirm_message, gate_confirm, confirm_handler, cancel_handler |
| `src/graph/subgraphs/cancel/compile.ts` | Compila con gate |
| `src/graph/compile.ts` | Wire en supervisor |
| Tests | 6 críticos: agregar al de confirm el de cancel implícito + double-confirm con intentUuid stale |

### H5.3 — Integración + documentación

| Entregable | Detalle |
|---|---|
| Update SPRINT.md + CLAUDE.md | H5 ✅ |
| Test E2E con MemorySaver | Agendar → confirmar → cancelar end-to-end (3 subgrafos en cadena) |

---

## 6. Tests críticos por subgrafo

### Confirm (5)

1. **No upcomings** → handed_off con texto explicativo.
2. **1 upcoming** → pre-fill + commit + success.
3. **N upcomings** → ask_slot lista → user picks → commit + success.
4. **Anti-alucinación** → commit con slot no resolved → `IdpError('invariant_violated')`.
5. **Race / backend error no-recoverable** → error_handler outcome=error.

### Cancel (6)

1-4. Idénticos al confirm pero con cancel commit.
5. **Cancel implícito mid-confirm** (usuario manda texto libre durante `awaiting_confirmation`) → cancel_handler → ask_slot.
6. **Tap stale** (`confirm:<old-uuid>` después de que se generó otro intentUuid) → rechazado con log warn.

---

## 7. Decisiones a fijar antes de codear

| # | Decisión | Recomendación |
|---|---|---|
| 1 | ¿`cancel` sin upcomings retorna handed_off o un mensaje informativo "no hay nada que cancelar"? | **Mensaje informativo** — handed_off implica escalación, lo cual no aplica acá. |
| 2 | ¿`confirm` con 1 solo upcoming auto-confirma sin pedirle al usuario, o pide confirmación? | **Pide siempre** — un "¿Confirmar el turno X?" claro, aunque sea redundante. Más seguro. Pero acá NO es un gate con interrupt — es solo una pregunta que el usuario responde sí/no en texto libre. Si decimos "ok, sí" → ejecuta. |
| 3 | ¿`cancel` con appointment que ya pasó (fecha en el pasado) → mensaje "ese turno ya pasó"? | **Sí**, validar antes de gate. Guacuco probablemente lo rechaza igual, pero mejor UX nuestro. |
| 4 | ¿Persistir el `intentUuid` del cancel en el outcome para auditoría? | **Sí** en logs, no en respuesta al usuario. |

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Usuario tiene 20+ upcomings (caso degenerado) | List message WhatsApp cap a 10 — agregar paginación o fallback a texto "tu próximo es X, decime el siguiente si querés otro". Doc OUT v1, dejar TODO. |
| Identity dual: staff cancela turno de cliente | Slot adicional `clientUuid` (igual que H4 §7). Decision a tomar en (#3 §7 del PLAN_H4): si búsqueda CRM no está, **scope OUT** staff-cancel-for-third-party para v1. |
| Cancel implícito ambiguo (usuario dice "ok") | El cancel implícito solo dispara con texto que NO sea button. "ok" es texto → trata como cancel implícito. Pero "ok" puede ser intentar confirmar. **Mitigation**: si el texto es muy corto y afirmativo (`ok`, `dale`, `si`, `sí`) → interpretarlo como confirm (mismo gate). Si es largo o ambiguo → cancel implícito. Heurística simple. |

---

## 9. Referencias

- [`docs/PLAN_H4_SCHEDULE_SUBGRAPH.md`](./PLAN_H4_SCHEDULE_SUBGRAPH.md) — patrón de subgrafo
- [`docs/REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §9 (anti-alucinación), §10 (requiresConfirmation)
- [`docs/specs/P1-idempotency-keys.md`](./specs/P1-idempotency-keys.md) — aplica a commit de ambos
