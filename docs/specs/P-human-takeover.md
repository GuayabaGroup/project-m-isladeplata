# Spec P-human-takeover — Takeover humano manual (bot mute)

> **Repo target**: `project-m-guacuco` (flag dueño + endpoint) + `project-m-isladeplata` (detección + gate)
> **Consumidor**: `project-m-isladeplata` (agente conversacional)
> **Prioridad**: media-alta — mejora la experiencia cuando el agente no alcanza,
> pero no bloquea el cutover (H8.4). Las capas A/B de detección no dependen de
> Guacuco y pueden ir primero detrás del flag.
> **Esfuerzo estimado**: medio (estado nuevo por conversación + gate en pre-grafo +
> detección en capas + endpoint/flag en Guacuco para la reactivación humana).
> **Estado**: PARCIALMENTE BLOQUEADO en Guacuco. La detección + el silenciado del
> bot (capas A/B con espejo en Redis) se pueden cablear hoy en isladeplata; la
> **reactivación explícita desde el dashboard** y la persistencia como fuente de
> verdad requieren el endpoint/flag en Guacuco. Esta spec define el contrato.

---

## Motivación

Cuando una conversación con un cliente no marcha bien, hoy no hay forma de
**inhabilitar las respuestas automáticas del LLM** para que un humano del negocio
tome la conversación y responda él. El agente siempre contesta el siguiente
mensaje.

Esto es **distinto** de los dos mecanismos parecidos que ya existen:

- **`forward_message`** (tool del grafo): reenvía *un* mensaje puntual del cliente
  al negocio ("estoy en la puerta", "llego tarde"). El bot sigue respondiendo los
  turnos siguientes. No silencia nada.
- **`handed_off` / spec `P-escalation`**: escalamiento **automático** cuando un
  *subgrafo* se traba (anti-loop, commit fallido, sin disponibilidad). El bot
  abandona *ese flujo* pero sigue contestando el próximo mensaje del thread.

El takeover humano introduce un estado nuevo por conversación —
**`human_controlled`**— en el que el bot **deja de responder** en ese `thread_id`
hasta que se reactive (humano + TTL de seguridad). Mientras está activo, los
mensajes entrantes se **persisten** (P2) para que queden en el historial del
dashboard, pero el bot no genera ninguna respuesta automática.

## Modelo de estado

- **Llave**: `thread_id` (`tenant:profile:channel:platform`, el mismo del
  checkpointer / P2). Una conversación = un estado de takeover.
- **Fuente de verdad: Guacuco.** El estado vive donde el staff humano ya opera
  (dashboard, turnos, mensajes — mismo razonamiento que P2/P-escalation). isladeplata
  lo escribe al auto-detectar y lo lee en cada turno; el dashboard lo limpia al
  reactivar.
- **Espejo en Redis con TTL** (`takeover:active:{thread_id}`) para que el gate del
  pre-grafo lea en caliente **sin roundtrip HTTP por turno**. El TTL del espejo es
  además el **TTL de seguridad** de reactivación (ver §Reactivación).

Estados: `bot` (default) → `human_controlled` (takeover activo) → `bot`
(reactivado).

## Detección (3 capas)

La detección corre en isladeplata, detrás de `HUMAN_TAKEOVER_ENABLED` (default
`false`). Capas ordenadas de más barata/determinística a más cara; cualquiera que
dispare entra a `human_controlled`.

| Capa | Señal | Mecanismo | Costo LLM |
|---|---|---|---|
| **A** | El cliente pide explícitamente un humano ("quiero hablar con una persona") | Intent nuevo en el supervisor LLM (ya clasifica intención) | 0 (reusa la call existente) |
| **B** | N salidas `handed_off`/`error` consecutivas en el thread | Contador en Redis (`takeover:fails:{thread_id}`, `INCR`+`EXPIRE`; se resetea en un outcome exitoso) | 0 |
| **C** | Frustración / insultos / repetición de quejas | Juez LLM por turno en el supervisor | 1 call/turno |

- Capas **A** y **B** no agregan llamadas LLM y se recomiendan como base.
- Capa **C** va detrás de su **propio flag** `TAKEOVER_SENTIMENT_ENABLED` (default
  `false`) para poder arrancar sin ella y prenderla con datos — respeta la
  filosofía anti-alucinación/determinismo de v1 (§REGLAS). Es la única capa que
  puede generar falsos positivos.
- El umbral de la capa B es `TAKEOVER_FAILS_THRESHOLD` (env, ej. `3`).

## Enforcement (gate en el pre-grafo)

Gate nuevo en `pregraph/pipeline.ts`, **después de resolver identidad** y antes del
rate-limit / `graph.invoke` (mismo patrón mecánico que los gates de dedup y
rate-limit):

```ts
// 4.5 Takeover gate: si un humano tomó la conversación, el bot calla.
if (env.HUMAN_TAKEOVER_ENABLED && (await this.takeover.isHumanControlled(thread_id))) {
  const outcome: Outcome = { action: 'ignored' };
  void this.persister.persistTurn(message, internalIdentity, outcome); // solo persistir, sin alerta
  takeoverMutedTotal.labels({ channel: message.channelType }).inc();
  return outcome;
}
```

- El bot **no responde**; el turno entrante queda en el historial (P2) para que el
  humano lo vea cuando entre al dashboard.
- `isHumanControlled` lee el **espejo Redis** (rápido). El estado de Guacuco se
  obtiene fuera del hot path: vía un campo nuevo en `resolveIdentity` (no agrega
  roundtrip) que repuebla el espejo si Redis lo perdió (restart / TTL).

## Reactivación

- **Explícita** (principal): el humano reactiva desde el dashboard de Guacuco →
  Guacuco limpia el flag → isladeplata lo ve en el próximo `resolveIdentity` e
  invalida el espejo Redis.
- **TTL de seguridad** (respaldo): el espejo Redis expira tras `TAKEOVER_TTL_SECONDS`
  (ej. 2-6h), así ninguna conversación queda muerta por olvido del humano. Al
  expirar, el bot vuelve a atender. Guacuco debería aplicar el mismo TTL del lado
  servidor para que su flag y el espejo no diverjan.

## Contrato HTTP (Guacuco)

### Entrar a takeover (lo escribe isladeplata al auto-detectar)

`POST /api/v1/conversations/takeover`
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
  "reason_code": "explicit_request",
  "subgraph": "schedule",
  "summary": "El cliente pidió explícitamente hablar con una persona.",
  "last_user_message": "quiero hablar con alguien de verdad",
  "ttl_seconds": 21600,
  "idempotency_key": "660e8400-e29b-41d4-a716-446655440001"
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `tenant_allia_id` | string | De `state.identity.tenantAlliaId`. |
| `thread_id` | string | Mismo `thread_id` del checkpointer / P2 — llave del estado de takeover. |
| `profile_uuid`, `profile_type` | string | Identidad del cliente cuya conversación se toma. |
| `channel`, `platform_id` | string, int | Para que el staff sepa por dónde está la conversación. |
| `reason_code` | enum | `explicit_request` \| `repeated_failures` \| `sentiment_frustration` \| `other`. (Capas A / B / C.) |
| `subgraph` | string \| null | Subgrafo activo al disparar, o null. |
| `summary` | string | Texto corto determinístico (sin UUIDs, PII enmascarada con `maskPII`). |
| `last_user_message` | string | Último mensaje del cliente, enmascarado. |
| `ttl_seconds` | int | TTL de seguridad acordado; Guacuco lo aplica server-side. |
| `idempotency_key` | string (UUID) | Dedup server-side; candidato: `${thread_id}:${turn_id}`. |

### Response

```json
{ "success": true, "data": { "takeover_id": "770e...", "created": true } }
```

- `created: false` cuando ya había un takeover activo para ese `thread_id` (mismo
  patrón idempotente de P1/P2/P-escalation).
- Envelope estándar Guacuco (`{success, data?, error?}`) — `BaseHttpClient.unwrap`.

### Lectura del estado

El flag `human_controlled` (con su `expires_at`) se devuelve como **campo nuevo en
`resolveIdentity`** (`POST /tools/resolve-identity`), no como un endpoint aparte, para
no agregar un roundtrip por turno: el pre-grafo ya llama a `resolveIdentity` en el
paso 2. isladeplata usa ese campo para repoblar el espejo Redis.

### Salir de takeover (reactivación humana)

La reactivación la dispara el **dashboard** de Guacuco (no isladeplata). Guacuco
limpia el flag; isladeplata lo detecta en el próximo `resolveIdentity`. No requiere
endpoint nuevo en isladeplata.

## Comportamiento server-side (Guacuco)

1. **Persistir** el takeover en una tabla `conversation_takeovers` (o reusar la infra
   de `forward_message`/escalaciones) con estado `human_controlled` y `expires_at`.
2. **Idempotencia** por `(tenant_allia_id, idempotency_key)` — un retry de isladeplata
   no duplica el takeover.
3. **Exponer** el flag activo en `resolveIdentity` para el thread correspondiente.
4. **Dashboard**: lista de conversaciones en `human_controlled` que el staff vigila
   y puede reactivar (ver hueco abierto abajo). Aplicar el mismo TTL de seguridad.

## Cableado en isladeplata

Todo detrás de `HUMAN_TAKEOVER_ENABLED` (default `false` hasta que Guacuco despliegue):

1. **`TakeoverStore`** (`infrastructure/redis/`): espejo `takeover:active:{thread_id}`
   (con TTL `TAKEOVER_TTL_SECONDS`) + contador de fallas `takeover:fails:{thread_id}`
   (`INCR`/`EXPIRE`, reset en outcome exitoso). Métodos `isHumanControlled`,
   `mirrorActive`, `clear`, `bumpFailures`, `resetFailures`. Sigue el patrón de
   `DedupStore`/`RateLimitStore` (§10 REGLAS: TTL explícito, `SCAN` no `KEYS`).
2. **Gate en `pregraph/pipeline.ts`** (§Enforcement): lee el espejo, persiste el turno
   (sin alerta), retorna `{ action: 'ignored' }`. Repuebla el espejo desde el campo
   de `resolveIdentity` si Redis lo perdió.
3. **Capa A — intent supervisor**: nuevo intent "pedir humano" en el clasificador del
   supervisor; al detectarlo, dispara el takeover.
4. **Capa B — contador**: en el pipeline, tras el dispatch, `bumpFailures` si
   `outcome.action ∈ {handed_off, error}` y `resetFailures` si fue exitoso; al cruzar
   `TAKEOVER_FAILS_THRESHOLD`, dispara.
5. **Capa C — juez sentimiento** (opt-in `TAKEOVER_SENTIMENT_ENABLED`): juez LLM en el
   supervisor; al clasificar frustración, dispara.
6. **`TakeoverNotifier`** (disparo fire-and-forget, análogo a `EscalationNotifier` /
   `ConversationPersister`): `POST /conversations/takeover` + `mirrorActive` en Redis.
   try/catch, **nunca bloquea el turno** (§13.5), counter `takeover_total{reason_code,
   result}`. `summary` determinístico desde la capa que disparó (NO call LLM extra),
   PII enmascarada con `maskPII`.
7. **Métricas**: `isladeplata_takeover_total{reason_code, result}` (disparos),
   `isladeplata_takeover_muted_total{channel}` (turnos silenciados por el gate).
8. **Env**: `HUMAN_TAKEOVER_ENABLED`, `TAKEOVER_SENTIMENT_ENABLED`,
   `TAKEOVER_FAILS_THRESHOLD`, `TAKEOVER_TTL_SECONDS` en `src/config/env.ts` **+**
   `tests/setup.ts` **+** `.env.example` (convención CLAUDE.md).

### Por qué fire-and-forget y no una tool del grafo

El takeover es un cambio de estado operativo del negocio, no parte del flujo
conversacional — igual que la persistencia de turnos (P2) y el escalamiento
(P-escalation). Meterlo como nodo agrega latencia y acopla el grafo a un backend
que puede estar caído. Si el disparo falla, el bot simplemente sigue atendiendo (el
counter de error + Sentry lo dejan visible); el gate de enforcement sí es síncrono
porque es barato (lectura Redis) y es lo que garantiza el silencio.

## Hueco abierto (decisión del owner)

- **Sin alerta al humano mientras está pausado.** La entrada es automática y, por
  decisión de scope, *no* se notifica activamente al humano (solo se persiste el
  turno). Consecuencia: el humano se entera **solo entrando al dashboard**; durante
  esa ventana el cliente espera sin respuesta de nadie. El TTL de seguridad evita el
  "muerto para siempre" pero no la demora. **Mitigación necesaria**: el dashboard
  debe tener una **cola visible de conversaciones en `human_controlled`** que el
  staff vigile activamente. Si esa cola no existe, reconsiderar y al menos notificar
  (push/email) al disparar — reusando el medio de `forward_message`/P-escalation.
- **Capa C (sentimiento)**: arrancar con `TAKEOVER_SENTIMENT_ENABLED=false` y
  evaluar prenderla con datos de falsos positivos.
- **TTL de seguridad concreto** (2h / 6h / otro): definir con volumen real.
- **Conflicto con interrupts pendientes**: si la conversación estaba en medio de un
  interrupt (ej. `ask_slot`) cuando entra el takeover, al reactivar el bot el
  checkpoint sigue ahí. Decidir si la reactivación limpia el thread o lo retoma.

## DoD

- Endpoint `POST /conversations/takeover` + flag en `resolveIdentity` desplegados en
  Guacuco con idempotencia y TTL server-side.
- `TakeoverStore` + gate en `pregraph/pipeline.ts` + capas A/B cableadas detrás de
  `HUMAN_TAKEOVER_ENABLED`, con tests: el gate silencia el bot (`action: 'ignored'`,
  turno persistido) cuando el thread está en `human_controlled`; el disparo es
  fire-and-forget (resuelve aunque Guacuco falle).
- Capa C detrás de `TAKEOVER_SENTIMENT_ENABLED` (default off).
- Una conversación auto-detectada queda silenciada para el bot, visible en el
  dashboard, y se reactiva por acción humana o por TTL de seguridad.
