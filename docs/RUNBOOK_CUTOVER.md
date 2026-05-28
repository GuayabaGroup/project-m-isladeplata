# Runbook — Cutover de IDP v2 → Isladeplata

> Operativa de pasaje a producción del agente conversacional. Decisión de scope:
> **cutover directo** (no rollout gradual), todos los negocios van a isladeplata
> desde el día 1. El rollback es a nivel global (revertir webhook de Meta).
>
> Pre-requisito firme: H8.1 (persistencia) y H8.2 (métricas) cerrados.
> P2 desplegado en Guacuco (`POST /api/v1/conversations/agent-turns`).

---

## 0. Resumen de 30 segundos

| Acción | Quién | Tiempo |
|---|---|---|
| Pre-deploy checklist | Quien hace deploy | 15 min |
| Deploy isladeplata + smoke test | Quien hace deploy | 20 min |
| Flip webhook URL en Meta Business Manager | Quien tiene admin de los negocios | 5 min |
| Observar primeras 24h | Oncall | continuo |

Punto de no-retorno: paso "flip webhook". Antes de eso, isladeplata está corriendo
pero no recibe tráfico; rollback = no flippear. Después de eso, rollback = re-flippear
a IDP v2 (mismo procedimiento inverso, ver §5).

---

## 1. Pre-deploy checklist

Marcar TODO antes de continuar al §2:

### Repositorios + builds

- [ ] `project-m-guacuco`: P2 (`POST /api/v1/conversations/agent-turns`) desplegado.
      Curl smoke desde un host de staging confirma 202 con `persisted: true|false`.
- [ ] `project-m-isladeplata`: rama main en commit que pasa typecheck + lint + tests
      (suite >= 590 verdes al cierre de H8.2).
- [ ] IDP v2: corriendo estable. NO se apaga en esta operación — queda como fallback.

### Infra externa

- [ ] Postgres del agente (`POSTGRES_URL`) provisionado, accesible desde el host
      de isladeplata. Schema vacío (LangGraph corre `setup()` al boot).
- [ ] Redis (`REDIS_URL`) provisionado. NO compartir con IDP v2 si ambos corren —
      colisión de keys de dedup. Si compartido, asegurar prefijo distinto.
- [ ] Tunel/red entre isladeplata y Guacuco testeado (`GUACUCO_URL` resoluble +
      `X-API-Key` válido). `curl $GUACUCO_URL/health` debe responder 200.

### Configuración

- [ ] `.env` de producción completo (referencia `.env.example`). Críticos para H8:
  - `NODE_ENV=production`
  - `SENTRY_DSN` apuntando a proyecto `isladeplata-prod`
  - `LANGSMITH_TRACING=true` (si vas a tracear) + `LANGSMITH_API_KEY` +
    `LANGSMITH_PROJECT=isladeplata-prod` +
    **`LANGSMITH_HIDE_INPUTS=true`** + **`LANGSMITH_HIDE_OUTPUTS=true`**
    (no hacerlo en prod es leak de PII al servicio externo — ver §13.6 REGLAS).
  - `METRICS_API_KEY` set a un secreto de 32+ chars; configurar Prometheus
    scrape con header `X-Metrics-Key: <secret>`.
  - `GUACUCO_API_KEY`, `PARGUITO_API_KEY`, `ANTHROPIC_API_KEY` válidos.
  - `WHATSAPP_VERIFY_TOKEN` (cualquier string secreto que matchea Meta config).
  - `WHATSAPP_CHANNEL_MAP_JSON` con `{phone_number_id: {access_token, role, platform_id}}`
    para cada número productivo.
  - `APP_SECRET_BY_PLATFORM_JSON` con `{platform_id: app_secret}` por plataforma
    (Allia/Groomia/Divapp).

### Observabilidad

- [ ] Sentry alert configurada: error rate > 5% en 5min en proyecto
      `isladeplata-prod` → PagerDuty (o similar).
- [ ] Prometheus scrape job apuntando a `https://<isladeplata-host>/metrics`
      con header de auth. Confirmar scraping verde antes del flip.
- [ ] Grafana board mínimo (puede ser post-cutover):
  - `rate(isladeplata_turn_processed_total[5m])` por `outcome_action`
  - `histogram_quantile(0.95, sum(rate(isladeplata_pipeline_latency_ms_bucket[5m])) by (le))`
  - `rate(isladeplata_persist_turn_total{result="error"}[5m])` — alerta si > 0
  - `rate(isladeplata_identity_not_found_total[5m])` — baseline esperado bajo
- [ ] LangSmith dashboard listo en proyecto `isladeplata-prod`. Confirmar que
      runs llegan (después del primer mensaje).

---

## 2. Deploy de isladeplata

### 2.1 Build + boot

```bash
pnpm install
pnpm build
node --enable-source-maps dist/main/server.js
```

(En la práctica esto vive detrás de systemd / Docker / PM2 / k8s. La forma del
runtime es agnóstica para este runbook — lo importante es que `bootstrap()` corra
con el `.env` correcto.)

Al arrancar, esperar estos logs en orden:

1. `LangSmith tracing enabled` (si TRACING=true) o `LangSmith tracing disabled`
2. Conexión Redis sin errores
3. Conexión Postgres del checkpointer + setup
4. `Metrics endpoint disabled (METRICS_API_KEY empty)` o ausente si está set
5. Servidor escuchando en `PORT`

### 2.2 Smoke test técnico (sin tráfico real)

```bash
# Health check — debe responder 200 con redis:true + postgres:true
curl -s http://<isladeplata-host>:<port>/health | jq

# Metrics endpoint (si METRICS_API_KEY está set)
curl -s -H "X-Metrics-Key: $METRICS_API_KEY" \
  http://<isladeplata-host>:<port>/metrics | head -20
# Debe ver líneas `# HELP isladeplata_turn_processed_total ...`

# Verify endpoint del webhook (lo usa Meta para validar el endpoint al setearlo)
curl -i "http://<isladeplata-host>:<port>/webhooks/whatsapp?\
hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=test123"
# Debe responder 200 con body "test123"
```

Si cualquiera falla → diagnose ANTES de §3. No flippear hasta resolver.

---

## 3. Flip del webhook en Meta Business Manager

Cuando isladeplata está corriendo + health verde + smoke test OK:

1. Entrar a Meta Business Manager → WhatsApp Business Account de cada negocio.
2. Settings → Webhooks → Callback URL.
3. Cambiar de la URL actual (IDP v2) a `https://<isladeplata-host>/webhooks/whatsapp`.
4. Verify token: el mismo que `WHATSAPP_VERIFY_TOKEN` del `.env`.
5. Meta hace un GET de verificación inmediato — debe responder 200.
6. Guardar.

Repetir para cada número productivo (cada `phone_number_id` en `WHATSAPP_CHANNEL_MAP_JSON`).

**Punto de no-retorno**: a partir de acá los mensajes de los usuarios llegan a
isladeplata. IDP v2 deja de recibir tráfico de los negocios flippeados.

---

## 4. Post-deploy verification (primeras 2 horas)

### 4.1 Smoke test funcional con número de prueba

Mandar al WhatsApp:

| Mensaje | Outcome esperado |
|---|---|
| `hola` | Respuesta social en <3s |
| `quiero un turno mañana a las 11 con María` | Subgrafo `schedule` arranca |
| `cuánto cuesta corte` | Subgrafo `query`, intent `service_prices` |
| `cancelá mi turno` | Subgrafo `cancel` con pre-fill si hay upcoming |

Para cada uno confirmar:
- Respuesta llega al teléfono.
- En `/metrics` el counter `isladeplata_subgraph_entered_total{subgraph="X"}` subió.
- En LangSmith aparece el trace del run.

### 4.2 Métricas baseline (primera hora)

Esperable en operación normal:

- `rate(isladeplata_turn_processed_total[5m])` matchea el volumen histórico
  de IDP v2 ± 20%. Caída drástica → webhook mal configurado en algún número.
- `rate(isladeplata_persist_turn_total{result="error"}[5m])` ≈ 0. Si > 0 →
  Guacuco P2 está roto o caído, revisar logs warn.
- `histogram_quantile(0.95, ...)` de pipeline_latency_ms < 3000ms. Mayor →
  saturación de algún componente (Guacuco / Anthropic / Postgres).
- `rate(isladeplata_identity_not_found_total[5m])` bajo. Spike → revisar si
  hay números nuevos no en `WHATSAPP_CHANNEL_MAP_JSON`.

### 4.3 Sentry

Filtro: `release:isladeplata-<version> AND environment:production`. Esperable:

- Errores < 1% del total de turnos.
- Tipos comunes esperados: `guacuco_invalid_envelope` (Guacuco caído), errores
  de timeout en Anthropic, redis disconnect transients.
- Spans `pipeline.process` con p95 < 3s.
- Sub-spans `pipeline.graph.invoke` dominan la latencia → normal.

Si un patrón de error aparece > 10 veces en 5min → considerar rollback (§5).

---

## 5. Rollback procedure

Disparado por cualquiera de:

- Error rate sostenido > 5% en Sentry durante 5 min.
- `persist_turn_total{result="error"}` no cae después de retry (Guacuco P2 mal).
- Latencia p95 > 10s sostenida.
- Reporte cualitativo de usuarios: respuestas malas, tiempos infinitos.

### 5.1 Pasos (5-10 min total)

1. En Meta Business Manager, revertir la callback URL a la de IDP v2 para
   cada número. Verify token de IDP v2 (probablemente otro). Save.
2. **A partir de este paso los mensajes vuelven a IDP v2**.
3. Isladeplata sigue corriendo (no apagar) — los threads activos con `interrupt()`
   quedan vivos en el checkpointer Postgres hasta TTL (24h). Si el rollback es
   definitivo, esos usuarios pierden el contexto del subgrafo activo; al próximo
   mensaje IDP v2 lo trata como nuevo turno.
4. Confirmar en logs de IDP v2 que está recibiendo tráfico de nuevo.
5. Postear en el canal de incidente: `rollback at <UTC>; root cause TBD`.

### 5.2 No se pierde nada de negocio

- Turnos creados / cancelados / reagendados → ya están en la BD de Guacuco
  (isladeplata escribe directo, no buffer local).
- Turnos persistidos en `conversation_threads`/`messages` (P2) → ya están en
  Guacuco. Después del rollback IDP v2 verá su propia conversación en otra
  tabla; no hay merge automático.
- Logs / métricas / traces → sobreviven en Sentry / Prometheus / LangSmith
  para post-mortem.

### 5.3 No se pierde casi nada de UX

- Threads en `interrupt()` (esperando respuesta del usuario) → siguiente
  mensaje del user va a IDP v2, no a isladeplata; pierde el contexto del
  subgrafo. Para el usuario es como reiniciar la conversación. **No es
  catastrófico** pero genera fricción.
- Mitigación opcional (post-mortem): mensaje proactivo desde IDP v2 al próximo
  turno de cada usuario afectado ("Reiniciamos tu sesión, ¿podés repetir lo
  último?"). Decisión §7 plan H8 #4.

---

## 6. Triage de incidentes

| Síntoma | Dónde mirar primero | Hipótesis comunes |
|---|---|---|
| Usuario no recibe respuesta | Logs winston por `messageId` → ver hasta dónde llegó el pipeline | Webhook signature inválida (HMAC), dispatcher falla en `WhatsAppSender` (token vencido) |
| Respuesta tarda > 10s | LangSmith trace del run + Sentry span `pipeline.process` | Anthropic timeout, Guacuco lento, Postgres saturado |
| Persistencia (P2) falla repetidamente | Counter `persist_turn_total{result="error"}` + logs warn `Persist turn failed` | Guacuco P2 caído, schema mismatch del payload |
| Spike de `identity_not_found_total` | logs info `Silent skip` por phone_number_id | Mapping de números desactualizado en `WHATSAPP_CHANNEL_MAP_JSON` |
| Memoria / latencia subiendo | LangSmith trace + Postgres `SELECT count(*) FROM checkpoints` | Job de cleanup del checkpointer no corre, threads abandonados se acumulan |
| LangSmith trae PII | `LANGSMITH_HIDE_INPUTS/OUTPUTS` en prod | env mal seteada, redeploy con valores correctos urgente |

---

## 7. Post-mortem (si hubo incidente)

Capturar para el post-mortem:

1. Traces de LangSmith del request type que falló (no de TODO el día — eso es ruido).
2. Sentry issue ID + timestamp del primer error.
3. Snapshot de métricas Grafana en la ventana del incidente.
4. Mensajes user/assistant relevantes desde la tabla `messages` de Guacuco
   (persistencia P2 — la ventaja exacta de H8.1).
5. Hipótesis + qué se cambió + cómo se validó la fix.

Documentar en `docs/incidents/<YYYY-MM-DD>-<short-title>.md` (template a crear
en el primer incidente).

---

## 8. Cleanup post-cutover (semanas después)

Cuando isladeplata corrió estable >= 2 semanas sin incidentes críticos:

- [ ] Apagar IDP v2 (proceso + recursos). Documentar el shutdown.
- [ ] Archivar el repo `project-m-idp_OV1` (read-only).
- [ ] Mantener Postgres del agente: útil para auditoría y debugging (decisión
      §7 plan H8 #5). TTL automático ya activo (24h).
- [ ] Cerrar H8.5 — actualizar SPRINT.md + CLAUDE.md con "proyecto v1 cerrado".

---

## 9. Referencias

- `docs/SPRINT.md` — H8 estado de hitos
- `docs/PLAN_H8_CUTOVER.md` — plan original (algunos puntos quedaron obsoletos
  por la decisión de cutover directo sin rollout gradual)
- `docs/specs/P2-agent-turns-persistence.md` — contrato del endpoint de
  persistencia
- `docs/REGLAS_ISLADEPLATA.md` §13 (seguridad / observability) y §3 (orden de
  bootstrap)
