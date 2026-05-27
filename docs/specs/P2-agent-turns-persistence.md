# Spec P2 — Endpoint para persistir turnos del agente

> **Repo target**: `project-m-guacuco`
> **Consumidor**: `project-m-isladeplata` (agente conversacional)
> **Prioridad**: P2 — debe estar desplegado antes de Hito 8 (cutover a producción).
> **Esfuerzo estimado**: medio (extensión de tablas existentes en `ConversationModule` + endpoint nuevo + DTO).

---

## Motivación

`ConversationModule` en Guacuco ya tiene infra de threads y messages (visible en `PgConversationThreadRepository`, `PgConversationV2Repository`). Sin embargo, no hay contrato definido para que un agente externo (Isladeplata) persista sus turnos.

Necesidad concreta:

- **Dashboards y CRM** deben ver la conversación entre cliente/staff y el agente sin tocar el checkpointer de LangGraph (que es interno de Isladeplata).
- **Auditoría** de qué dijo el bot y por qué.
- **Métricas de calidad**: qué tools se invocaron, qué subgrafo procesó cada turno, tiempo de respuesta.
- **Soporte humano**: cuando un caso escala, el agente humano necesita ver el historial completo.

El checkpointer Postgres del agente (LangGraph) es la fuente de verdad **operativa** (estado conversacional, threads pausados en interrupts). Guacuco es la fuente de verdad **analítica**.

## Contrato HTTP

### Request

`POST /api/v1/conversations/agent-turns`
Auth: `X-API-Key`
Content-Type: `application/json`

```json
{
  "tenant_allia_id": "wu7tdc",
  "thread_id": "550e8400-e29b-41d4-a716-446655440000:abc-123:whatsapp:1",
  "profile_uuid": "abc-123",
  "profile_type": "client",
  "channel": "whatsapp",
  "platform_id": 1,
  "turn_id": "660e8400-e29b-41d4-a716-446655440001",
  "turns": [
    {
      "role": "user",
      "content": "quiero un turno para corte mañana a las 4",
      "received_at": "2026-05-27T15:30:00Z",
      "metadata": {
        "message_id": "wamid.ABC...",
        "interactive_payload": null
      }
    },
    {
      "role": "assistant",
      "content": "Listo, te agendo corte con María mañana 28 de mayo a las 16:00. ¿Confirmás?",
      "sent_at": "2026-05-27T15:30:02Z",
      "outcome_action": "awaiting_user",
      "subgraph": "schedule",
      "tool_calls": [
        {
          "tool_name": "validate_tool",
          "input": { "tool_name": "schedule_appointment", "date": "2026-05-28", "appointment_time": "16:00" },
          "result_status": "ok"
        }
      ]
    }
  ]
}
```

### Campos

| Campo | Tipo | Req | Descripción |
|---|---|---|---|
| `tenant_allia_id` | string | Sí | Identificador del negocio en Guacuco. |
| `thread_id` | string | Sí | Identificador del thread del agente. Formato sugerido: `${tenantUuid}:${profileUuid}:${channel}:${platformId}`. |
| `profile_uuid` | uuid | Sí | El cliente o staff que está conversando. |
| `profile_type` | `'client' \| 'staff'` | Sí | Tipo de perfil. |
| `channel` | string | Sí | `whatsapp`, `telegram`, `mobile`, `web`. |
| `platform_id` | smallint | Sí | 1=Allia, 2=Groomia, 3=Divapp. |
| `turn_id` | uuid | Sí | UUID único del turno (par user + assistant). **Idempotencia se calcula por este key**. |
| `turns` | array | Sí | Array de 1-N mensajes. Típicamente 1 user + 1 assistant. Puede tener solo user si el grafo terminó sin response (ej. silent skip). |

### Cada turn

| Campo | Tipo | Req | Descripción |
|---|---|---|---|
| `role` | `'user' \| 'assistant'` | Sí | |
| `content` | string | Sí | Texto del mensaje. Para assistant puede incluir solo el texto formateado, no markdown estructurado. |
| `received_at` / `sent_at` | ISO8601 | Sí | Según rol. |
| `metadata.message_id` | string | No | ID externo del canal (wamid para WA, message_id para TG). |
| `metadata.interactive_payload` | object | No | Si el mensaje fue un tap de botón / list pick. |
| `outcome_action` | string | No (solo en assistant) | `response`, `awaiting_user`, `error`, `ignored`, `rate_limited`, `handed_off`. |
| `subgraph` | string | No (solo en assistant) | `schedule`, `reschedule`, `cancel`, `query`, `null` para fast-paths sociales. |
| `tool_calls` | array | No (solo en assistant) | Tools que se invocaron en este turno (puede ser 0+). Cada tool con `{tool_name, input, result_status, error_code?}`. |

### Response

```json
{
  "success": true,
  "data": {
    "turn_id": "660e8400-e29b-41d4-a716-446655440001",
    "persisted": true
  }
}
```

| Status | Caso |
|---|---|
| 202 Accepted | Turno aceptado (incluso si `persisted: false` por duplicado). |
| 400 Bad Request | Body inválido (faltan campos required, formatos malos). Agente loguea `warn` y descarta. |
| 401 Unauthorized | API key inválida. |
| 500 | Error interno. Agente loguea `warn` y descarta (fire-and-forget). |

**Idempotencia**: si llega el mismo `turn_id` dos veces, ignorar y retornar `persisted: false`. El UNIQUE constraint en la tabla maneja esto a nivel BD.

## Schema (extensión de tablas existentes)

Asumiendo que `conversation_threads` y `messages` ya existen en `ConversationModule`:

### `conversation_threads` — añadir columnas (si no existen)

```sql
ALTER TABLE conversation_threads
  ADD COLUMN IF NOT EXISTS agent_thread_id TEXT,
  ADD COLUMN IF NOT EXISTS profile_type    TEXT,
  ADD COLUMN IF NOT EXISTS channel         TEXT,
  ADD COLUMN IF NOT EXISTS platform_id     SMALLINT;

CREATE INDEX IF NOT EXISTS idx_threads_agent_lookup
  ON conversation_threads(tenant_allia_id, agent_thread_id);
```

### `messages` — añadir columnas

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS turn_id          UUID NOT NULL,
  ADD COLUMN IF NOT EXISTS subgraph         TEXT,
  ADD COLUMN IF NOT EXISTS tool_calls       JSONB,
  ADD COLUMN IF NOT EXISTS outcome_action   TEXT,
  ADD COLUMN IF NOT EXISTS metadata         JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_turn_role
  ON messages(thread_id, turn_id, role);
```

(Estructura final puede variar según el schema actual del `ConversationModule`; el equipo Guacuco adapta.)

## Comportamiento del handler

1. Validar body (Zod schema).
2. Resolver/crear `conversation_threads` por `(tenant_allia_id, agent_thread_id)`. Idempotente.
3. INSERT cada mensaje del array `turns` en `messages`. ON CONFLICT (turn_id, role) DO NOTHING.
4. Si todos los inserts hicieron skip por conflict → return `persisted: false`.
5. Si al menos uno persistió → return `persisted: true`.

## Backwards-compatibility

- Endpoint nuevo, no rompe ningún consumidor existente.
- Las columnas añadidas a `messages` y `conversation_threads` son `NULL`-able (excepto `turn_id` que es required en INSERTs del nuevo endpoint pero no afecta filas existentes — se aplica solo a inserts desde este endpoint).

## Testing (criterios de aceptación)

### Casos positivos
1. **Thread nuevo + 1 turno user+assistant** → ambos persisten, thread se crea.
2. **Thread existente + nuevo turn_id** → mensajes se agregan al thread.
3. **Re-envío del mismo turn_id** → `persisted: false`, no duplica.
4. **Solo mensaje user** (caso silent skip / rate limit) → persiste user, sin assistant.
5. **Múltiples tool_calls en un assistant** → todos se persisten en el JSONB.

### Casos de validación
6. **Body sin `tenant_allia_id`** → 400.
7. **`profile_type` inválido** → 400.
8. **`turn_id` no es UUID** → 400.
9. **Array `turns` vacío** → 400.
10. **Auth con API key inválida** → 401.

### Casos de aislamiento
11. **Mismo turn_id en threads diferentes** → independientes (uniqueness es por thread_id + turn_id + role).
12. **Cross-business**: tenant_allia_id no matchea ningún business activo → 400 `BUSINESS_NOT_FOUND`.

## Métricas a exponer

- `agent_turns_persisted_total{tenant_allia_id, channel}` — turnos persistidos.
- `agent_turns_skipped_duplicates_total` — duplicados ignorados.
- `agent_turns_rejected_total{reason}` — rejects por validación.

## Definition of Done

- [ ] Migration de schema aplicada (columnas + índices).
- [ ] Endpoint expuesto en `infrastructure/http/routes/`.
- [ ] DTO + use case + repo implementados.
- [ ] 12 casos de test pasan.
- [ ] Documentación del endpoint en `docs/api/`.
- [ ] Métricas expuestas y verificadas en dashboard.
- [ ] Validado: el dashboard CRM puede consultar threads/messages persistidos por el agente.
