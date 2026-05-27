# Spec P1 — Idempotency keys en writes de `/tools/execute`

> **Repo target**: `project-m-guacuco`
> **Consumidor**: `project-m-isladeplata` (agente conversacional con LangGraph)
> **Prioridad**: P1 — debería estar desplegado antes de Hito 4 del sprint Isladeplata (subgrafo `schedule_appointment`).
> **Esfuerzo estimado**: bajo (1 tabla + wrapper sobre execute + 1 job de recovery).

---

## Motivación

El agente Isladeplata puede reintentar requests de write contra Guacuco por varias razones legítimas:

- Reintento automático tras flake de red (RetryClient retry policy).
- Doble-tap del usuario en botón "Confirmar" antes de que llegue la primera response.
- Restart del proceso del agente entre el `commit` y el persist del checkpoint (LangGraph reanuda el último checkpoint conocido, que podría no incluir el éxito del write).
- Concurrencia controlada en el cliente que dispara dos in-flight.

Sin idempotency, cualquiera de estos casos puede producir **dos turnos creados** (o cancelaciones/reschedules duplicados). El agente puede mitigar parcialmente con su propio state, pero la red de seguridad correcta es a nivel del backend.

## Alcance

Aplica solo a `tool_name` de **escritura**:

- `schedule_appointment`
- `cancel_appointment`
- `reschedule_appointment`
- `confirm_appointment`

Tools de **lectura** (`check_availability`, `query_database`, `tools/validate`) NO requieren idempotency.

## Contrato HTTP

### Request

Endpoint existente: `POST /api/v1/tools/execute` (no se crea endpoint nuevo).

Se agrega un campo opcional al body, **top-level** (no dentro de `parameters`):

```json
{
  "tool_name": "schedule_appointment",
  "idempotency_key": "550e8400-e29b-41d4-a716-446655440000",
  "parameters": { ... },
  "context": { ... }
}
```

**Reglas del campo**:
- Tipo: `UUID v4` (validar formato).
- Opcional. Sin él → flujo actual sin cambios.
- Solo se procesa si `tool_name` está en la lista de write tools (arriba). Si llega con `tool_name='check_availability'` se ignora silenciosamente.
- Scope: la unicidad se calcula por `(business_uuid, idempotency_key)`. Mismo key en business distintos → independientes.

### Response

Cuando llega un request con `idempotency_key` ya registrado dentro de la ventana TTL (10 minutos), el comportamiento depende del estado del original:

| Estado del original | Response del replay |
|---|---|
| `in_progress` | `409 Conflict` con `error.code = 'IDEMPOTENT_REQUEST_IN_PROGRESS'`. El agente espera + reintenta. |
| `succeeded` | Mismo status + body que el original (típicamente 201 con `appointment_uuid`, etc.). |
| `failed` | Mismo status + body de error que el original. |

Esto garantiza al cliente que **el segundo request nunca ejecuta el handler dos veces**.

## Schema de BD

```sql
CREATE TABLE tool_idempotency_keys (
  id                BIGSERIAL PRIMARY KEY,
  business_uuid     UUID NOT NULL,
  tool_name         TEXT NOT NULL,
  idempotency_key   UUID NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('in_progress','succeeded','failed')),
  response_payload  JSONB,
  http_status       SMALLINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (business_uuid, idempotency_key)
);

CREATE INDEX idx_idemp_orphan
  ON tool_idempotency_keys(expires_at)
  WHERE status = 'in_progress';

CREATE INDEX idx_idemp_cleanup
  ON tool_idempotency_keys(created_at);
```

## Algoritmo de procesamiento

```
1. Si !idempotency_key OR tool_name NOT IN write_set:
     → ejecutar handler normalmente, return.

2. INSERT INTO tool_idempotency_keys (
       business_uuid, tool_name, idempotency_key,
       status, expires_at
   ) VALUES (
       :biz, :tool, :key,
       'in_progress', NOW() + INTERVAL '10 minutes'
   ) ON CONFLICT (business_uuid, idempotency_key) DO NOTHING
   RETURNING id;

3. Si INSERT no devolvió fila (conflict):
     → SELECT status, response_payload, http_status FROM ... WHERE ...
     - status='in_progress' → return 409 IDEMPOTENT_REQUEST_IN_PROGRESS
     - status='succeeded'   → return http_status + response_payload
     - status='failed'      → return http_status + response_payload (error envelope)
     - row not found (race) → goto 2 con backoff corto

4. Ejecutar el handler.

5. Según resultado:
     - OK:    UPDATE ... SET status='succeeded', response_payload=:body,
                                http_status=:status, completed_at=NOW()
     - Error: UPDATE ... SET status='failed', response_payload=:body,
                                http_status=:status, completed_at=NOW()

6. Return el response del handler.
```

## Recovery de in_progress huérfanos

Si el proceso muere entre pasos 4 y 5, queda una fila `in_progress` que nunca se actualiza. Para recovery:

- Job cada 60s: `UPDATE tool_idempotency_keys SET status='failed', response_payload=:error, http_status=500, completed_at=NOW() WHERE status='in_progress' AND expires_at < NOW()`.
- El error payload puede ser genérico: `{ success: false, error: { code: 'EXECUTION_ABORTED', message: 'Request execution did not complete' } }`.
- Reusa la infraestructura de jobs/workers existente en Guacuco.

## Cleanup periódico

Job diario que borra filas con `created_at < NOW() - INTERVAL '7 days'` (después de TTL + gracia para análisis si hace falta).

## Backwards-compatibility

- Campo opcional → todos los clientes actuales (IDP v2, integraciones externas) siguen funcionando sin cambios.
- IDP v2 no se actualiza para usar idempotency; solo Isladeplata.
- Si IDP v2 manda un `idempotency_key` por accidente, se procesa correctamente (no rompe).

## Testing (criterios de aceptación)

### Casos positivos
1. **Replay después de success** → mismo `appointment_uuid` y mismo body.
2. **Replay después de failure** → mismo error code y body.
3. **Two concurrent requests same key** → solo uno ejecuta el handler. El segundo recibe 409 o el response del primero (según timing).
4. **Replay después de TTL expirado (>10 min)** → ejecuta de nuevo (key liberada).
5. **Key distinto para misma intención** → ejecuta como request normal (no es idempotency).

### Casos de aislamiento
6. **Mismo key en business diferentes** → independientes, cada uno ejecuta.
7. **Mismo key en tool diferentes (write set)** → independientes.
8. **Key en tool no-write** → ignorado, ejecuta normal.

### Casos de recovery
9. **Proceso muere mid-execution** → recovery job marca `failed` después de TTL.
10. **Replay durante recovery** → 409 hasta que recovery corra, luego 500 con error genérico.

### Casos de validación
11. **UUID inválido** → 400 con error code claro.
12. **Idempotency key sin `tool_name`** → 400 (validación normal del execute).

## Métricas a exponer

- `tool_idempotency_replays_total{tool, status}` — cuántos replays se atrapan.
- `tool_idempotency_in_progress_recovered_total` — cuántos huérfanos se recuperan.
- `tool_idempotency_table_rows_total{status}` — tamaño de la tabla.

## Definition of Done

- [ ] Migration de schema aplicada.
- [ ] Lógica del wrapper en `ExecuteToolUseCase` (o equivalente) cubre los 12 casos de test.
- [ ] Job de recovery configurado en el worker scheduler.
- [ ] Job de cleanup periódico configurado.
- [ ] Documentación del campo `idempotency_key` actualizada en `docs/tools.md`.
- [ ] Métricas expuestas y verificadas en dashboard.
- [ ] Cross-business protection validada: write con `business_allia_id` de otro tenant + idempotency key → sigue retornando `BUSINESS_MISMATCH` (la idempotency NO bypassea la validación de tenant).
