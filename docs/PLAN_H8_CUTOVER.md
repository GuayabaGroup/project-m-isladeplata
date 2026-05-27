# Plan H8 — Persistencia de turnos + cutover gradual

> No es un subgrafo nuevo — es la capa de **operación** que transforma a Isladeplata de "código que pasa tests" a "código corriendo en producción atendiendo negocios reales". Es donde se valida que el reemplazo de IDP v2 funciona.
>
> Pre-requisitos: H7 committeado (todos los subgrafos funcionando con tests verdes). **Requiere P2 desplegado en Guacuco** (endpoint `/api/v1/conversations/agent-turns`).

---

## 0. Contexto

Tres pilares paralelos:

1. **Persistir cada turno en Guacuco** (fire-and-forget al cierre del pipeline). Para que dashboards CRM vean la conversación sin tocar el checkpointer.
2. **Métricas operativas**: latencia p50/p95 por etapa, error rate, intents clasificados, commits exitosos, % rate-limited, etc. A Sentry Performance + LangSmith + posible dashboard interno.
3. **Cutover gradual con feature flag**: routear webhook a IDP v2 o Isladeplata por `business_uuid`. Rollout 1 piloto → 5 → 20 → todos.

DoD del hito: **1 negocio piloto corriendo en Isladeplata 1 semana sin regresiones críticas, comparativa side-by-side con IDP v2 muestra paridad funcional**.

---

## 1. Persistencia de turnos (P2 integration)

### 1.1 Cliente HTTP

Agregar a `GuacucoClient` un método nuevo:

```typescript
async persistAgentTurns(payload: PersistAgentTurnsRequest): Promise<{turn_id: string; persisted: boolean}>;
```

Body shape definido en `docs/specs/P2-agent-turns-persistence.md`.

### 1.2 Construcción del payload

Helper nuevo en `src/pregraph/ConversationPersister.ts`:

```typescript
export class ConversationPersister {
  constructor(private readonly guacuco: GuacucoClient, private readonly logger: Logger) {}

  /**
   * Build payload from pipeline state + outcome, then send fire-and-forget.
   * NEVER throws — uses swallowAsync.
   */
  async persistTurn(
    message: ChannelMessage,
    identity: Identity,
    outcome: Outcome,
    metadata?: {
      subgraph?: string;
      toolCalls?: Array<{ tool_name: string; input: unknown; result_status: 'ok' | 'error' }>;
    },
  ): Promise<void> {
    const payload = {
      tenant_allia_id: identity.tenantAlliaId,
      thread_id: `${identity.tenantUuid}:${identity.profileUuid}:${identity.channel}:${identity.platformId}`,
      profile_uuid: identity.profileUuid,
      profile_type: identity.profileType,
      channel: identity.channel,
      platform_id: identity.platformId,
      turn_id: randomUUID(),
      turns: [
        {
          role: 'user' as const,
          content: maskPII(message.contentText),
          received_at: message.receivedAt,
          metadata: {
            message_id: message.messageId,
            interactive_payload: message.interactivePayload,
          },
        },
        ...(outcome.pendingReply
          ? [{
              role: 'assistant' as const,
              content: outcome.pendingReply.text ?? renderReplyAsText(outcome.pendingReply),
              sent_at: new Date().toISOString(),
              outcome_action: outcome.action,
              subgraph: metadata?.subgraph,
              tool_calls: metadata?.toolCalls,
            }]
          : []),
      ],
    };
    await swallowAsync(this.logger, 'Persist turn failed', this.guacuco.persistAgentTurns(payload));
  }
}
```

### 1.3 Integración con pipeline

`src/pregraph/pipeline.ts` invoca `persister.persistTurn(...)` **después** del dispatch:

```typescript
// Step 9 (new): persist turn fire-and-forget
this.persister.persistTurn(message, internalIdentity, outcome, {
  subgraph: graphResult.routing?.activeSubgraph,
  toolCalls: extractToolCallsFromGraphResult(graphResult),
}).catch(() => {}); // already swallowed internally, double-safety
```

**Importante**: ni await ni return — fire-and-forget. Si falla → log warn, no rompe el turno.

### 1.4 Tests

- Persister con GuacucoClient mockeado: payload correcto.
- Persister con GuacucoClient lanzando: no propaga, log warn.
- Pipeline integration: turn dispatcheado + persist se invoca con metadata correcta.

---

## 2. Métricas

### 2.1 Sentry Performance (para latencia)

Wrap el pipeline en una transaction:

```typescript
async process(message: ChannelMessage): Promise<Outcome> {
  return Sentry.startSpan({
    name: 'pipeline.process',
    attributes: { 'isladeplata.channel': message.channelType },
  }, async () => {
    // existing processInternal
  });
}
```

Sub-spans para cada paso (dedup, identity, rate limit, graph invoke, dispatch, persist).

### 2.2 LangSmith (ya configurado en H3.A)

Los traces del grafo ya se envían automáticamente cuando `LANGSMITH_TRACING=true`. En producción:
- `LANGSMITH_HIDE_INPUTS=true`, `LANGSMITH_HIDE_OUTPUTS=true`.
- `LANGSMITH_PROJECT=isladeplata-prod`.

### 2.3 Métricas custom

Counter por evento, agregables por business + channel + intent:

```typescript
// src/infrastructure/observability/metrics.ts
export const metrics = {
  turnProcessed: counter('turn_processed', ['channel', 'business_uuid', 'outcome_action']),
  intentClassified: counter('intent_classified', ['intent', 'confidence_bucket']),
  toolInvoked: counter('tool_invoked', ['tool_name', 'result']),
  subgraphEntered: counter('subgraph_entered', ['subgraph']),
  rateLimitHit: counter('rate_limit_hit', ['channel']),
  identityNotFound: counter('identity_not_found', []),
  pipelineLatencyMs: histogram('pipeline_latency_ms', ['outcome_action']),
};
```

Implementación: usar `prom-client` para exposición Prometheus en `/metrics` endpoint protegido por API key.

### 2.4 Dashboards

A construir post-cutover con el equipo de ops. Mínimo viable:
- Grafana board con turn_processed por business + outcome.
- Sentry alert si `error rate > 5%` en 5min.
- LangSmith review semanal de traces sample.

---

## 3. Cutover gradual

### 3.1 Feature flag

Implementación más simple: una env var en el load balancer / proxy upstream que decide a qué backend ruteo según `business_uuid` (o `phone_number_id`).

Como Isladeplata y IDP v2 viven en procesos separados, el flag NO vive dentro de Isladeplata — vive en el routing front (nginx, Caddy, proxy custom).

Alternativa: webhook dual entry — Meta apunta a un endpoint puente que decide. Más complejo.

**Recomendación**: configurar en Caddyfile (heredado de IDP v2 setup) por `business_uuid` matcher. Caddy snippet:

```
# Pseudo-config (verificar sintaxis Caddy)
@isladeplata header X-Business-Uuid biz-piloto-1
handle @isladeplata {
  reverse_proxy localhost:4000  # isladeplata
}
handle {
  reverse_proxy localhost:3000  # IDP v2
}
```

Como Meta no manda `X-Business-Uuid` directo, el front debe resolverlo del `phone_number_id` antes. Un endpoint slim de routing puede hacer eso.

**Decisión a fijar (§7)**: ¿routing por Caddy con phone_number_id matcher, o por endpoint dual con redirect interno? Mi recomendación: **endpoint slim de routing en Node** (más fácil de testear, observable).

### 3.2 Rollout plan

| Fase | Negocios | Duración | DoD |
|---|---|---|---|
| Piloto | 1 negocio (interno o cooperador) | 1 semana | Sin regresiones críticas. Comparativa con IDP v2: paridad funcional (mismos turnos creados, mismas respuestas social). |
| Expansión 1 | 5 negocios (mix client+staff, mix plataformas) | 2 semanas | Error rate < 2%, p95 latencia < 3s. |
| Expansión 2 | 20 negocios | 1 semana | Idem. |
| Full | Todos | — | Apagar IDP v2 después de 2 semanas estables. |

### 3.3 Runbook de rollback

Si en cualquier fase aparece un bug crítico:

1. **Instantáneo**: flip flag → todo el tráfico vuelve a IDP v2.
2. Los **threads pausados** (`interrupt()`) en Isladeplata quedan en el checkpointer Postgres hasta TTL (24h). Si rolleamos atrás definitivamente, los usuarios pierden el contexto del subgrafo activo — pero al próximo mensaje IDP v2 lo trata como nuevo (no es catastrófico, hay degradación de UX).
3. **Datos del negocio** (turnos, cancelaciones) NO se pierden — todo va a Guacuco, no a Isladeplata.
4. **Logs y métricas** sobreviven para post-mortem (Sentry, LangSmith, Postgres del agente).
5. Generar incidente con: traces de LangSmith del caso, logs estructurados, hipótesis.

Documentar el runbook en `docs/RUNBOOK_CUTOVER.md` (no en este plan).

---

## 4. Validación side-by-side con IDP v2

Comparativa durante piloto: por cada turno procesado en Isladeplata, **shadow-procesar también en IDP v2** (sin enviar respuesta) y comparar:

- Intent clasificado: ¿el mismo?
- Tool/subgrafo invocado: ¿el mismo?
- Outcome (created appointment uuid o no, texto de respuesta similar): ¿paridad?

Discrepancias → log + Sentry capture con label `shadow_diff`. Review semanal.

Esto requiere infra de shadow processing — pesado. **Alternativa más simple**: pre-piloto, run 100 mensajes ejemplo (de logs históricos de IDP v2) por Isladeplata y comparar manualmente. Aceptable si los 100 cubren los casos clave.

**Decisión a fijar (§7)**: ¿shadow processing online o pre-piloto offline de 100 mensajes?

---

## 5. Plan de implementación (sub-hitos)

### H8.1 — Persistencia de turnos

| Entregable | Detalle |
|---|---|
| `GuacucoClient.persistAgentTurns` | DTO + método |
| `ConversationPersister` clase | Builder de payload + fire-and-forget |
| Integración en `pipeline.ts` | Step 9 |
| `maskPII` helper | Para teléfonos, emails en `content` |
| Tests | 3 tests: payload correcto, persister no rompe, pipeline integration |
| **Bloqueo**: P2 desplegado en Guacuco | sin esto, los calls fallan; mockeo en tests OK |

### H8.2 — Métricas

| Entregable | Detalle |
|---|---|
| `src/infrastructure/observability/metrics.ts` | prom-client counters + histograms |
| Endpoint `/metrics` con apiKeyAuth | Para Prometheus scraping |
| Sentry transactions/spans | Wrap pipeline + subgrafos |
| LangSmith config verificada en producción | `HIDE_INPUTS=true`, project `isladeplata-prod` |
| Tests | metrics counters incrementan correctamente en cada path |

### H8.3 — Routing dual + cutover infra

| Entregable | Detalle |
|---|---|
| Endpoint slim de routing (Node) o Caddyfile | Decisión §3.1 |
| Smoke test contra ambos backends | `curl` con header → verifica routing |
| Documentar en `docs/RUNBOOK_CUTOVER.md` | Pasos exactos del flip |

### H8.4 — Piloto + validación

| Entregable | Detalle |
|---|---|
| Onboarding del primer negocio | Coordinación con stakeholder |
| Comparativa offline 100 mensajes (decisión §4) | Aceptación de paridad |
| Métricas durante semana piloto | Dashboards iniciales |
| Post-mortem si hay incidentes | Documentado |

### H8.5 — Expansión y full cutover

| Entregable | Detalle |
|---|---|
| Rollout fase 5 → 20 → all | Según criterios §3.2 |
| Plan de apagado IDP v2 | 2 semanas estables → apagar |
| Update SPRINT.md + CLAUDE.md | Hito H8 ✅, proyecto v1 cerrado |
| Memorias del proyecto actualizadas | Reflejan estado producción |

---

## 6. Tests críticos del hito

- **Smoke contra Guacuco staging**: persist agent turns endpoint responde 202.
- **Pipeline integration**: turno → outcome → persist es invocado con metadata correcta.
- **Métricas**: counter `turn_processed` incrementa en cada path (response, error, rate_limited, ignored).
- **Routing dual**: header `X-Business-Uuid=biz-piloto-1` → response del path Isladeplata. Header de otro business → response IDP v2.
- **Rollback simulado**: flip flag, verificar que próximo turno va a IDP v2.

---

## 7. Decisiones a fijar antes de codear

| # | Decisión | Recomendación |
|---|---|---|
| 1 | Routing dual: Caddyfile vs endpoint Node slim | **Endpoint Node slim** — más testeable, observable. |
| 2 | Shadow processing online vs comparativa offline pre-piloto | **Offline pre-piloto 100 mensajes** — más barato, suficiente para detectar regresiones gruesas. |
| 3 | ¿Métricas vía prom-client o solo Sentry Performance? | **Ambos**: Sentry para latencia + alerting; prom-client para counters agregables. Cap operativo. |
| 4 | ¿Qué hacer con threads activos al rollback definitivo? | Mensaje proactivo al usuario al próximo turno (vía IDP v2): "Reiniciamos tu sesión, ¿podés repetir lo último?" |
| 5 | ¿Cleanup del Postgres del agente después del cutover full? | **Mantener** — útil para auditoría y debugging post-mortem. Cleanup automático ya activo (TTL). |

---

## 8. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| P2 atrasa, no se puede persistir turnos | Media | H8 ejecuta sin H8.1 (skip persist). Persistencia se agrega cuando P2 esté. |
| Discrepancias con IDP v2 más altas de lo esperado en piloto | Alta | Plan: documentar cada diferencia, decidir si es regresión o mejora. Si regresión crítica → fix antes de expansión. |
| Rollback durante pico de tráfico causa pérdida de threads activos | Media | Mensaje proactivo (decisión #4 §7). Documentar en runbook. |
| Routing dual mal configurado → traffic split incorrecto | Alta | Test exhaustivo del routing en staging antes de prod. Smoke check post-deploy. |
| Métricas instrumentation degrada performance | Baja | prom-client + Sentry son livianos. Verificar p95 antes y después. |
| LangSmith con `HIDE_INPUTS=false` en prod → PII leak | Media | Re-verificar config en deploy. CI check que falle si combinación NODE_ENV=prod + HIDE_INPUTS=false está presente. |

---

## 9. Referencias

- [`docs/SPRINT.md`](./SPRINT.md) H8
- [`docs/specs/P2-agent-turns-persistence.md`](./specs/P2-agent-turns-persistence.md) — bloqueante
- [`docs/REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §13.6 (LangSmith en prod)
- `docs/RUNBOOK_CUTOVER.md` (a crear en H8.3)
- IDP v2 — para shadow processing si se decide implementar
