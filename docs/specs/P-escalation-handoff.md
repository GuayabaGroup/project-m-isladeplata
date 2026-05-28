# Spec P-escalation — Endpoint de escalamiento a humano (handoff)

> **Repo target**: `project-m-guacuco`
> **Consumidor**: `project-m-isladeplata` (agente conversacional)
> **Prioridad**: alta — debería estar antes del cutover (H8.4). Hoy el agente
> promete "un humano te va a contactar" pero **no notifica a nadie**.
> **Esfuerzo estimado**: bajo-medio (endpoint nuevo + cola/notificación; reusa
> el patrón de `forward_message` que ya existe).
> **Estado**: BLOQUEADO en Guacuco (el endpoint no existe). Esta spec define el
> contrato; el cableado en isladeplata es chico una vez disponible.

---

## Motivación

Cuando un subgrafo abandona (`outcome.action='handed_off'`), el usuario recibe
un texto del tipo *"un humano del equipo te va a contactar"*, pero el
`ResponseDispatcher` solo envía ese texto **al usuario** — no hay cola, ticket
ni alerta hacia el negocio. La promesa queda sin cumplir.

Disparadores actuales de `handed_off` (todos terminan en el mismo callejón):

- Guard anti-loop (`meta.attempts >= MAX_ATTEMPTS`) en `ask_slot` de schedule/
  confirm/cancel/reschedule.
- `commit_*` con `ToolExecutionError` no mapeado (ej. `STAFF_NOT_AVAILABLE`
  irrecuperable, `APPOINTMENT_NOT_FOUND`, errores de Guacuco).
- `present_options` sin sugerencias disponibles.
- `IDEMPOTENT_REQUEST_IN_PROGRESS` (P1).

`forward_message` **sí** notifica al negocio (`executeTool('forward_message')`),
pero solo se dispara cuando el supervisor clasifica la intención del usuario
como "reenviar un mensaje" — nunca en un abandono de subgrafo.

Guacuco es la fuente de verdad analítica/operativa del negocio (ver spec P2), así
que la cola de escalamientos debe vivir ahí: el dashboard del negocio y el staff
humano la consumen desde el mismo lugar donde ya ven turnos y mensajes.

## Contrato HTTP

### Request

`POST /api/v1/conversations/escalations`
Auth: `X-API-Key`
Content-Type: `application/json`

```json
{
  "tenant_allia_id": "wu7tdc",
  "thread_id": "550e8400-...:abc-123:whatsapp:1",
  "profile_uuid": "abc-123",
  "profile_type": "client",
  "channel": "whatsapp",
  "platform_id": 1,
  "reason_code": "anti_loop_guard",
  "subgraph": "schedule",
  "summary": "El cliente intentó agendar 5 veces sin completar los datos.",
  "last_user_message": "no entiendo",
  "idempotency_key": "660e8400-e29b-41d4-a716-446655440001"
}
```

Campos:

| Campo | Tipo | Notas |
|---|---|---|
| `tenant_allia_id` | string | Del `state.identity.tenantAlliaId`. |
| `thread_id` | string | Mismo `thread_id` del checkpointer / P2 — permite cruzar con el historial. |
| `profile_uuid`, `profile_type` | string | Identidad del usuario que quedó trabado. |
| `channel`, `platform_id` | string, int | Para que el staff sepa por dónde contactar. |
| `reason_code` | enum | `anti_loop_guard` \| `commit_failed` \| `no_availability` \| `idempotent_in_progress` \| `invariant_violated` \| `other`. |
| `subgraph` | string \| null | `schedule`/`confirm`/`cancel`/`reschedule`/`query` o null. |
| `summary` | string | Texto corto generado por el agente describiendo el caso (sin UUIDs, PII enmascarada). |
| `last_user_message` | string | Último mensaje del usuario, enmascarado (`maskPII`). |
| `idempotency_key` | string (UUID) | Server-side dedup — ver abajo. Candidato natural: `intentUuid` del subgrafo, o `${thread_id}:${turn_id}`. |

### Response

```json
{ "success": true, "data": { "escalation_id": "770e...", "created": true } }
```

- `created: false` cuando el `idempotency_key` ya existía (re-entrega/reintento).
- Envelope estándar Guacuco (`{success, data?, error?}`) — `BaseHttpClient.unwrap`
  lo procesa como cualquier otra call.

## Comportamiento server-side (Guacuco)

1. **Persistir** la escalación en una tabla `agent_escalations` (o reusar la
   infra de `forward_message`) con estado inicial `open`.
2. **Idempotencia** por `(tenant_allia_id, idempotency_key)` — un retry del
   agente no duplica el ticket (mismo patrón que P1/P2).
3. **Notificar** al negocio por el canal que Guacuco ya use para alertas de staff
   (el mismo de `forward_message`). Fuera de scope de isladeplata definir el
   medio (push, email, fila en dashboard) — es decisión de Guacuco.
4. El dashboard del negocio lista escalaciones `open` y permite cerrarlas.

## Cableado en isladeplata (cuando el endpoint exista)

Cambios chicos, todos detrás de un flag `ESCALATION_ENABLED` (default false hasta
que Guacuco despliegue):

1. **`GuacucoClient.createEscalation(payload, ctx)`** → `POST /conversations/escalations`.
   Tipos en `clients/types/GuacucoTypes.ts`. Patrón idéntico a `persistAgentTurns`.
2. **Disparo desde el pipeline (fire-and-forget)**: en `pregraph/pipeline.ts`,
   tras el dispatch, si `outcome.action === 'handed_off'` y `ESCALATION_ENABLED`,
   `void escalationNotifier.notify(message, identity, outcome, { subgraph, reasonCode })`.
   - Análogo a `ConversationPersister`: try/catch + counter `escalation_total{result}`,
     nunca bloquea el turno (§13.5).
   - El `reason_code` se deriva del subgrafo + del `outcome`; para mapear el
     motivo fino conviene que los nodos terminales dejen un `reasonCode` en el
     `terminalOutcome` (campo opcional nuevo) o en `routing.handoff`.
3. **`summary`**: construir determinístico desde el subgrafo + attempts (NO una
   call LLM extra — barato y sin alucinación). PII enmascarada con `maskPII`.
4. **Métrica**: `isladeplata_escalation_total{reason_code, subgraph, result}`.
5. **Env**: `ESCALATION_ENABLED` en `env.ts` + `tests/setup.ts` + `.env.example`.

### Por qué fire-and-forget y no una tool del grafo

El escalamiento es un side-effect analítico/operativo, no parte del flujo
conversacional — igual que la persistencia de turnos (P2). Meterlo como nodo
agrega latencia (escritura) y acopla el grafo a un backend que puede estar
caído. Si falla, el usuario igual recibió su mensaje; el counter de error +
Sentry lo dejan visible.

## Decisiones abiertas (para el owner)

- **Medio de notificación** (push/email/dashboard): decisión de Guacuco.
- **¿Auto-escalar también `outcome.action='error'`?** Un error técnico (invariant
  violated, red caída) también deja al usuario sin resolver. Propuesta: sí, con
  `reason_code='invariant_violated'`/`'other'`, mismo endpoint.
- **SLA / re-notificación** si nadie toma el ticket en X minutos: fuera de scope
  v1; evaluar con datos de volumen.

## DoD

- Endpoint desplegado en Guacuco con idempotencia + notificación al negocio.
- `GuacucoClient.createEscalation` + `EscalationNotifier` cableados detrás de
  `ESCALATION_ENABLED`, con tests fire-and-forget (resuelve aunque Guacuco falle).
- Un `handed_off` real genera un ticket visible para el staff y un mensaje al
  usuario (los dos lados de la promesa cumplidos).
