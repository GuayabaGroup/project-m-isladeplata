# Plan H6 — Subgrafo `reschedule_appointment`

> Mezcla de schedule (validar nuevo slot + confirmación) + cancel (referencia a un appointment existente). Reutiliza ~80% del código de H4 y H5.
>
> Pre-requisitos: H5 committeado. **Requiere P3 desplegado en Guacuco** (`validate` unificado con `tool_name='reschedule_appointment'` + `appointment_uuid` en context). Si P3 demora, scope-out reschedule del v1 o usar el endpoint legacy `validate_reschedule_slot` con un comment de TODO.

---

## 0. Contexto

Reschedule = "cambiar fecha/hora de un turno existente". Slots: `appointment_uuid` (el existente) + `new_date` + `new_time`. `staff_uuid` y `service_uuids` **NO** se piden — vienen del appointment existente vía Guacuco (lectura interna).

Diferencias respecto a schedule (H4):
- No se ingresan service/staff (se heredan).
- Slot extra `appointment_uuid` (referenciado, no creado).
- `validate_availability` con context extra `{appointment_uuid}` que indica a Guacuco "excluí este slot del cálculo de ocupado" (sino el propio slot del usuario aparece ocupando consigo mismo y reagendar a la misma hora falla).

Diferencias respecto a cancel (H5):
- Sí tiene `availability` cache (necesita validar el nuevo slot).
- Sí tiene present_options.

---

## 1. State del subgrafo

```typescript
export interface RescheduleDraftState {
  slots: {
    appointmentUuid: SlotState<string>;
    newDate: SlotState<string>;
    newTime: SlotState<string>;
  };
  availability: {
    lastCheckedFor?: { newDate: string; newTime: string; appointmentUuid: string };
    exactMatch?: boolean;
    proposedSlots: Array<{ date: string; time: string; label: string }>;
  };
  confirmation: { intentUuid?: string; message?: string; requestedAt?: string };
  phase:
    | 'collecting'
    | 'validating_availability'
    | 'awaiting_pick'
    | 'awaiting_confirmation'
    | 'committing'
    | 'done'
    | 'failed';
  meta: { attempts: number; recoverableErrors: string[] };
}
```

Casi idéntico al schedule pero sin `services`/`staff` en slots.

---

## 2. Mapa del subgrafo

```
entry → bootstrap_from_upcoming → check_completeness
                                       │
                       missing slot    │ all resolved
                                       │
                       ┌───────────────▼──────────────┐
                       │ ask_slot                     │
                       │ (appointment_uuid: list      │
                       │  de upcomings; new_date+time:│
                       │  texto libre)                │
                       └───────────────┬──────────────┘
                                       │ user reply
                       ┌───────────────▼──────────────┐
                       │ interpret_user_reply         │
                       │ (parseUserSlotReply)         │
                       └───────────────┬──────────────┘
                                       │
                       ┌───────────────▼──────────────┐
                       │ validate_availability        │
                       │ (Guacuco /tools/validate     │
                       │  con appointment_uuid en ctx)│
                       └─┬──────────────────────────┬─┘
              exact match│                          │ no match
                         │                          │
              ┌──────────▼───────────┐  ┌───────────▼─────────────┐
              │ build_confirm_msg    │  │ present_options         │
              │ ("¿Reagendamos X al  │  │ (list de proposedSlots) │
              │  jueves 10:00?")     │  └───────────┬─────────────┘
              └──────────┬───────────┘              │ user picks
                         │                ┌─────────▼──────────────┐
              ┌──────────▼───────┐        │ apply_proposed_slot    │
              │ gate_confirm     │        └─────────┬──────────────┘
              └──┬────────────┬──┘                  │
       confirm   │            │ cancel/free-text   │
                 │            │                    │
       ┌─────────▼──────┐     │                    │
       │ commit         │     │                    │
       │ (Guacuco       │     │                    │
       │  reschedule_   │     │                    │
       │  appointment)  │     │                    │
       └─────────┬──────┘     │                    │
                 │            │                    │
       ┌─────────▼──────┐     │                    │
       │ success_resp   │     │                    │
       └─────────┬──────┘     │                    │
                 │            │  ┌─────────────────▼┐
                 │            │  │ (loop a ask_slot)│
                 │            │  └──────────────────┘
                 │            │
               EXIT          EXIT (cancel_handler)
```

---

## 3. Nodos compartidos con H4/H5 (reuso)

| Nodo | Reusado de | Variación |
|---|---|---|
| `entry` | H4 | Slots diferentes (sin services/staff) |
| `bootstrap_from_upcoming` | H5 | Mismo: lookup `state.crmContext.upcomingAppointments`, pre-fill `appointmentUuid` si único |
| `parseUserSlotReply` | H4 | Sin cambios |
| `interpret_user_reply` | H4 | Acepta `new_date`/`new_time` en vez de `date`/`time` |
| `validate_availability` | H4 | Llama `guacuco.validateRescheduleSlot(...)` con `appointment_uuid` en context |
| `availability_router` | H4 | Sin cambios |
| `present_options` | H4 | Sin cambios |
| `apply_proposed_slot` | H4 | Copia a `newDate`/`newTime` |
| `build_confirm_message` | H4 | Prompt distinto ("¿Reagendar...?") |
| `gate_confirm` | H4 | Sin cambios |
| `confirm_handler` | H4 | Sin cambios |
| `cancel_handler` | H4 | Sin cambios |
| `commit` | H4 | Llama `guacuco.rescheduleAppointment(...)` con idempotencyKey |
| `success_response` | H4 | Texto distinto ("Reagendado para...") |
| `error_handler` | H4 | Sin cambios |
| `assertSlotsResolved` | H4 | Slots distintos |

**Lo único realmente nuevo**: el `validate_availability` pasa `appointment_uuid` en context. Ya tenemos el método `GuacucoClient.validateRescheduleSlot` desde H1 listo para esto.

---

## 4. `validate_availability` para reschedule (clave)

```typescript
async function validateRescheduleAvailability(state, deps): Promise<GraphStateUpdate> {
  const { appointmentUuid, newDate, newTime } = state.slots;
  const result = await deps.guacuco.validateRescheduleSlot({
    new_date: newDate.value!,
    new_time: newTime.value!,
    business_allia_id: globalState.identity.tenantAlliaId,
    staff_uuid: '<viene del appointment existente — ver nota>',
    service_uuids: ['<idem>'],
    appointment_uuid: appointmentUuid.value!,
  });
  // populate state.availability como en schedule
}
```

**Nota crítica**: `validateRescheduleSlot` requiere `staff_uuid` y `service_uuids`. Estos NO los pedimos al usuario porque vienen del appointment existente. **Dos opciones**:

**(A)** Lookup en Guacuco al inicio del subgrafo: `bootstrap_from_upcoming` llama un endpoint que devuelve detalle del appointment (staff + services). Cachea en el state subgrafo (extra slots `inheritedStaffUuid`, `inheritedServiceUuids`). **Problema**: requiere endpoint `GET /appointments/{uuid}` que tal vez no existe en Guacuco como tool.

**(B)** Confiar en que `bootstrap_from_upcoming` ya tiene esa info: `identity.profileData.appointments` o `crmContext.upcomingAppointments` debe traer `staff_uuid` y `service_uuids` por appointment. **Verificar shape al implementar H6**. Si no los trae, ampliar la spec ResolveIdentity para incluirlos (cambio en Guacuco, similar a especificaciones P2).

Recomendación: **opción (B) con verificación temprana**. Si el shape de `upcomingAppointments` no trae staff+services, abrir mini-spec P6 en Guacuco para ampliarlo. Bajo esfuerzo, bloqueante para H6.

---

## 5. Anti-alucinación

Idéntica a H4 (§4 del PLAN_H4):

- `appointment_uuid` viene de la lista de upcomings (Guacuco-provided).
- `new_date`/`new_time` por `parseUserSlotReply` o `apply_proposed_slot` (Guacuco-provided suggestions).
- `commit` función pura con `assertSlotsResolved`.

---

## 6. Plan de implementación (sub-hitos)

### H6.1 — Spec gap check + state + nodos básicos

| Entregable | Detalle |
|---|---|
| Verify Guacuco upcomings shape | Confirmar que `upcomingAppointments[].staff_uuid` y `.service_uuids[]` están disponibles. Si no, abrir spec en Guacuco (mini-PR) antes de seguir. |
| `src/graph/subgraphs/reschedule/state.ts` | `RescheduleDraftState` + reducers |
| `src/graph/subgraphs/reschedule/nodes/entry.ts` + `bootstrap_from_upcoming.ts` + `ask_slot.ts` + `interpret_user_reply.ts` | Adaptaciones de H4/H5 |
| Tests | 4 críticos básicos |

### H6.2 — Validación + present_options + confirm

| Entregable | Detalle |
|---|---|
| `nodes/validate_availability.ts` | Llama `validateRescheduleSlot` con `appointment_uuid` |
| `nodes/present_options.ts` + `apply_proposed_slot.ts` | Reuso de H4 |
| `nodes/build_confirm_message.ts` + `gate_confirm.ts` + `confirm_handler.ts` + `cancel_handler.ts` | Reuso H4 con prompts ajustados |
| Tests | Validate happy/no-match, present_options, gate confirm/cancel |

### H6.3 — Commit + responses + integración

| Entregable | Detalle |
|---|---|
| `nodes/commit.ts` | `guacuco.rescheduleAppointment` con `idempotencyKey` |
| `nodes/success_response.ts` + `error_handler.ts` | Reuso con prompts ajustados |
| `compile.ts` del subgrafo + wire en supervisor | Reemplaza placeholder de H3.B |
| Tests E2E | 7 críticos completos |

### H6.4 — Documentación

| Entregable | Detalle |
|---|---|
| Update SPRINT.md + CLAUDE.md | H6 ✅ |

---

## 7. Tests críticos (7)

1. **No upcomings** → handed_off.
2. **1 upcoming + nuevo slot disponible** → bootstrap + ask new_date+new_time → validate exact → confirm → commit.
3. **N upcomings + nuevo slot disponible** → ask cuál → ask new_date+new_time → ... → commit.
4. **Reschedule al mismo slot del propio appointment** → válido (P3 garantiza exclude self).
5. **Nuevo slot ocupado** → present_options → user pick → confirm → commit.
6. **Race en commit** (`STAFF_NOT_AVAILABLE`) → recovery → re-validate.
7. **Anti-alucinación** — `appointment_uuid` no resolved en commit → `IdpError`.

---

## 8. Decisiones a fijar antes de codear

| # | Decisión | Recomendación |
|---|---|---|
| 1 | ¿Permitir cambiar staff/service en reschedule? (en algunos negocios, sí) | **No v1** — solo fecha/hora. Cambiar staff/service = cancel + schedule nuevo (UX explícito). |
| 2 | ¿Confirmar al usuario los detalles "inmutables" (staff, service) en el build_confirm_message? | **Sí** — "Reagendar tu corte con María del jueves 10:00 al **viernes 14:00**". Da contexto. |
| 3 | ¿Si P3 no está desplegado, usar endpoint legacy `validate_reschedule_slot`? | **Sí**, con comment `// TODO: migrar a /tools/validate cuando P3 esté desplegado`. Documentar en commit. |
| 4 | ¿Reschedule a fecha del pasado → handed_off o error amable? | **Error amable** ("no podés reagendar a una fecha pasada, ¿qué fecha querés?") y volver a ask. |

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| `upcomingAppointments` no trae staff/service | Verificar shape en H6.1 antes de seguir. Si no, mini-spec P6 en Guacuco. |
| P3 no desplegado en Guacuco al llegar a H6 | Usar endpoint legacy como fallback (decisión #3 §8). |
| Usuario quiere reagendar appointment de hace mucho tiempo (fecha pasada) | Validar antes del gate (decisión #4 §8). |
| Confusión cancel implícito vs cambio mid-confirm | Mismo handling que H4 (cancel_handler limpia confirmation + availability, slots preservados). |

---

## 10. Referencias

- [`docs/PLAN_H4_SCHEDULE_SUBGRAPH.md`](./PLAN_H4_SCHEDULE_SUBGRAPH.md) — la mayoría del patrón
- [`docs/PLAN_H5_CONFIRM_CANCEL.md`](./PLAN_H5_CONFIRM_CANCEL.md) — patrón de `bootstrap_from_upcoming`
- [`docs/specs/P3-unify-reschedule-validate.md`](./specs/P3-unify-reschedule-validate.md) — bloqueante; el endpoint que H6 consume
