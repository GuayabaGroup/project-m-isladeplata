# ⚠️ DESCARTADA — Spec P3 — Unificar `validate_reschedule_slot` bajo `/tools/validate`

> **STATUS (2026-05-27): DESCARTADA**. Esta spec asumía que Guacuco tenía un
> endpoint genérico `POST /api/v1/tools/validate` con un
> `ToolValidationHandlerRegistry`. Durante H6.0 (Isladeplata) se verificó que
> Guacuco **NUNCA tuvo ese endpoint** — solo `POST /api/v1/tools/execute`. El
> tool `validate_reschedule_slot` ya existe como `ToolHandler` legacy y se
> invoca via `executeTool('validate_reschedule_slot', ...)` con shape
> `{appointment_uuid, profile_uuid, date_hint[], time_hint}`. Deriva
> staff+services del appointment_uuid (no requiere context extra).
>
> H6 se implementó contra ese tool legacy. No hace falta unificar. La
> deprecación del legacy queda fuera de alcance del v1 de Isladeplata.

> **Repo target**: `project-m-guacuco`
> **Consumidor**: `project-m-isladeplata` (agente conversacional)
> **Prioridad**: ~~P3 — debe estar desplegado antes de Hito 6 (subgrafo `reschedule`)~~ Descartada.
> **Esfuerzo estimado**: bajo (nuevo `ToolValidationHandler` para `reschedule_appointment` + deprecación del endpoint legacy).

---

## Motivación

Hoy hay dos caminos paralelos para validar slots:

| Camino | Tool | Endpoint | Estado |
|---|---|---|---|
| Schedule | `schedule_appointment` | `POST /api/v1/tools/validate` (genérico) | Vigente. |
| Reschedule | `reschedule_appointment` | `POST /api/v1/tools/validate_reschedule_slot` (específico, legacy heredado de IDP v2) | A deprecar. |

Esto implica:
- Lógica duplicada en Guacuco (el endpoint específico tiene su propio handler con shape distinto).
- En Isladeplata, el subgrafo `reschedule` no puede reusar el nodo `validate_availability` del `schedule` 1:1; necesita un branch o un cliente distinto.
- Suggestions con formato distinto entre los dos paths.

La unificación elimina ~80% del código del subgrafo `reschedule` al permitir reuso de los nodos del `schedule`.

## Cambios en Guacuco

### 1. Nuevo handler

Crear `ValidateRescheduleAppointmentHandler implements ToolValidationHandler` en `src/domain/use-cases/tool/handlers/`. Estructura análoga a `ScheduleAppointmentValidationHandler`:

- `toolName = 'reschedule_appointment'`
- Parámetros validables: `new_date`, `new_time`
- Context requerido: `business_allia_id`, `staff_uuid`, `service_uuids`, **`appointment_uuid`** (extra respecto a schedule)

### 2. Registro en el registry

Agregar al `ToolValidationHandlerRegistry` en el DI container.

### 3. Comportamiento

Casi idéntico al `schedule_appointment` validate, con dos diferencias:

#### A. Exclusión del slot del propio appointment

La validación de disponibilidad debe **excluir el slot del `appointment_uuid` que se está reagendando** del cálculo de "ocupado". Sin esto, el slot actual del usuario aparece como conflictivo consigo mismo, y reagendar a la misma fecha+hora rechaza incorrectamente.

Implementación: extender `validateSlotAvailability` (o el wrapper que invoque el handler) para aceptar `excludeAppointmentUuid` opcional. Cuando está presente, filtrar appointments con ese UUID del calendario antes de calcular disponibilidad.

⚠️ **Nota**: `validateSlotAvailability()` es **TIER 1 protegida** en REGLAS_GUACUCO. Cualquier cambio en su signatura requiere aprobación del owner.

#### B. Parámetros validables con nombres distintos

El validate usa los nombres del payload del tool execute correspondiente:

| Tool | Param `date` | Param `time` |
|---|---|---|
| `schedule_appointment` | `date` | `appointment_time` |
| `reschedule_appointment` | `new_date` | `new_time` |

El handler de validate para reschedule debe aceptar `new_date` / `new_time` (no `date` / `appointment_time`).

### 4. Suggestions

Misma semántica que schedule:
- Si solo `new_date` falla → `suggestions.new_date = ['YYYY-MM-DD', ...]` (3 fechas).
- Si solo `new_time` falla → `suggestions.new_time = ['HH:mm', ...]` (3 horarios).
- Si ambos validados juntos y ambos fallan → `suggestions.combined = ['YYYY-MM-DD HH:mm', ...]`.

## Contrato HTTP

### Request (ejemplo)

```json
POST /api/v1/tools/validate
{
  "tool_name": "reschedule_appointment",
  "parameters": [
    { "name": "new_date", "value": "2026-06-15" },
    { "name": "new_time", "value": "16:00" }
  ],
  "context": {
    "business_allia_id": "wu7tdc",
    "staff_uuid": "abc-123",
    "service_uuids": ["svc-456"],
    "appointment_uuid": "apt-678"
  }
}
```

### Response (válido)

```json
{
  "success": true,
  "data": {
    "valid": true,
    "results": [
      { "name": "new_date", "valid": true, "message": null },
      { "name": "new_time", "valid": true, "message": null }
    ]
  }
}
```

### Response (inválido, ambos fallan)

```json
{
  "success": true,
  "data": {
    "valid": false,
    "results": [
      { "name": "new_date", "valid": false, "message": "No availability on this date" },
      { "name": "new_time", "valid": false, "message": "Time slot is not available" }
    ],
    "suggestions": {
      "combined": ["2026-06-16 10:00", "2026-06-16 11:00", "2026-06-17 09:00"]
    }
  }
}
```

## Deprecación del endpoint legacy

`validate_reschedule_slot` (endpoint específico) se marca como **DEPRECATED**:

- Log warning estructurado cuando se invoca: `logger.warn('Deprecated endpoint invoked: validate_reschedule_slot. Use POST /api/v1/tools/validate with tool_name=reschedule_appointment', {caller_ip, api_key_hash})`.
- Mantener funcional durante 1 release ciclo (~1 mes).
- En el siguiente release, retornar 410 Gone con mensaje de migración.
- IDP v2 NO se actualiza (queda usando el legacy hasta su deprecación completa con el cutover de Isladeplata).
- Isladeplata usa solo el nuevo endpoint desde el día 1.

## Backwards-compatibility

- IDP v2 sigue usando `validate_reschedule_slot` sin cambios.
- El nuevo handler en `/tools/validate` con `tool_name='reschedule_appointment'` es completamente nuevo, no rompe ningún caller existente.

## Testing (criterios de aceptación)

### Casos del path mismo-slot
1. **Reschedule al mismo slot del propio appointment** → `valid: true` (no se trata como conflicto consigo mismo).
2. **Reschedule a slot 30 min antes del propio** (cuando dura 1h y se solaparía consigo mismo si no se excluye) → `valid: true` si el resto del calendario lo permite.

### Casos de validación normal
3. **Reschedule a slot ocupado por otro turno** → `valid: false` con suggestions.
4. **Reschedule a fecha pasada** → `valid: false`.
5. **Reschedule a fecha sin horario del staff** → `valid: false`.

### Casos combinados
6. **Validación combinada con `new_date` y `new_time`** → mismo comportamiento que schedule (única call a `validateSlotAvailability`).
7. **Suggestions combinadas** → formato `YYYY-MM-DD HH:mm`.

### Casos de context
8. **Sin `appointment_uuid` en context** → validar normalmente (sin exclusión), pero loguear `warn` porque es un uso degradado.
9. **`appointment_uuid` inexistente** → 400 con error code claro (no degradar silenciosamente).
10. **`appointment_uuid` de otro tenant** → 400 `BUSINESS_MISMATCH` o `APPOINTMENT_NOT_FOUND` mascarado.

### Casos de deprecación
11. **Invocar endpoint legacy** → logea warning estructurado pero responde normal.
12. **Invocar endpoint legacy desde Isladeplata** → no debería pasar (Isladeplata usa el nuevo); si pasa, hay bug en Isladeplata.

## Métricas a exponer

- `tool_validate_calls_total{tool_name}` — volumen por tool.
- `tool_validate_legacy_endpoint_calls_total` — para monitorear cuánto falta para retirar el legacy.

## Definition of Done

- [ ] `ValidateRescheduleAppointmentHandler` implementado y testeado.
- [ ] Handler registrado en `ToolValidationHandlerRegistry`.
- [ ] `validateSlotAvailability` (TIER 1) extendida con `excludeAppointmentUuid` opcional, con aprobación del owner.
- [ ] 12 casos de test pasan.
- [ ] Endpoint legacy `validate_reschedule_slot` logea warning de deprecación.
- [ ] Documentación actualizada en `docs/tools.md` con la sección de `reschedule_appointment` validate.
- [ ] Métricas expuestas.
- [ ] Cross-business protection validada: `appointment_uuid` de otro tenant → rechaza.
