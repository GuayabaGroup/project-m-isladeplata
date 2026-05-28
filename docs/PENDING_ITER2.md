# Pendientes para iter 2

> Features intencionalmente excluidas de v1 que quedan registradas para futuras
> iteraciones. Reabrir cuando haya datos de producción que justifiquen el
> esfuerzo, o cuando el piloto exponga limitaciones concretas.

---

## H7 — Subgrafo `query`

### QueryJudge (LLM extra validador post-ejecución)

> **✅ IMPLEMENTADO (2026-05-28)** — port en `src/graph/subgraphs/query/queryJudge.ts`
> (`validateSql` + `validateSynthesis`, fail-open/closed por env). Wireado en
> `fetchIntent` (retry por critique) y `synthesizeResponse` (retry + fallback
> determinístico). Opt-in vía `QUERY_JUDGE_ENABLED` (default true). Decisión:
> el cutover directo sin piloto supervisado eliminó la razón para diferirlo.

**Qué es**: un LLM secundario (Haiku) que valida tanto la SQL generada vs el
schema+intención como la síntesis vs los rows ejecutados. Si rechaza, fuerza
retry con su `critique` como feedback al generador.

**Referencia**: `../project-m-idp_OV1/src/conversation/QueryJudge.ts` +
`QueryEngine.validateSqlContext` / `validateSynthesisContext`.

**Por qué fuera de v1**: duplica costo de LLM por query (1 generate + 1 judge SQL
+ 1 synthesize + 1 judge synth = 4 calls vs 2 sin judge). Vale el costo cuando
el agente va a producción directo sin piloto humano-supervisado. Para piloto
controlado, el costo no se justifica.

**Cuándo reabrir**: si tracking de Sentry muestra tasa alta de respuestas
incorrectas o alucinadas en freeform_sql (≥5%) durante piloto.

---

### Drill-down retry

> **✅ IMPLEMENTADO (2026-05-28)** — `historyLooksLikeDrilldown` en
> `conversationHistory.ts` + retry forzado en `fetchIntent` + bloque DRILL-DOWN
> en `prompts/querySql.ts`. Depende del historial (ver Anáforas, ya implementado).

**Qué es**: detección de imperativos cortos sin verbo ("dame detalles",
"con quien", "que servicios", "fechas") que continúan la consulta previa.
El generador SQL hereda WHERE+rango del último turno del usuario y solo
ajusta el SELECT proyectando columnas descriptivas adicionales.

**Referencia**: `QueryEngine.historyLooksLikeDrilldown` + bloque `DRILL-DOWN`
en `prompts/query-sql.ts` de IDP_OV1.

**Por qué fuera de v1**: requiere historial conversacional inyectado al prompt
(ver Anáforas) y heurística para detectar el patrón. Sin esto, los imperativos
cortos caen en `cannot_answer`. Workaround del usuario: reformular con verbo
explícito ("dame los detalles del turno", "qué servicios incluye").

**Cuándo reabrir**: cuando se implemente Anáforas (son pre-requisito) o cuando
métricas muestren ≥10% de queries en producción siendo follow-ups cortos
rechazados.

---

### Anáforas (history en prompt SQL + synthesis)

> **✅ IMPLEMENTADO (2026-05-28)** — `state.messages` ahora se puebla en el
> `subgraphFinalize` compartido (par user/assistant por turno). `fetchIntent` y
> `synthesizeResponse` construyen el historial con `buildConversationHistory`
> (últimos 6 turnos) y lo inyectan a generación SQL, síntesis y ambos judges.

**Qué es**: inyectar los últimos N turnos (IDP_OV1 usa 6) al prompt de
`generateSql` y `synthesizeResponse` para resolver pronombres y
determinantes ("¿y la próxima?", "y en abril?", "ese mismo", "el último").

**Referencia**: `QueryEngine.buildConversationHistory` + bloque
`HISTORIAL RECIENTE DE LA CONVERSACION` en `prompts/query-sql.ts`.

**Por qué fuera de v1**: requiere acceso a `state.messages` desde el subgrafo
query (hoy no lo recibimos). Agrega tokens al prompt (cada turno cuenta).
Riesgo de contaminación del prompt con texto mal sanitizado.

**Cuándo reabrir**: junto con drill-down retry. Es el pre-requisito.

---

### `business_hours` — tool dedicada en Guacuco

**Qué es**: tool `get_business_hours` que devuelve horario operativo del
negocio (día de la semana + rango de horas) sin requerir SQL.

**Por qué fuera de v1**: no existe el tool en Guacuco. Las preguntas de
horarios caen en `freeform_sql` (donde el LLM puede inferir contra el schema
si las tablas tienen working_hours) o en `cannot_answer`. Workaround
suficiente para v1.

**Cuándo reabrir**: si las preguntas "¿qué horarios tienen?" / "¿están
abiertos los domingos?" aparecen frecuentemente en logs y freeform_sql las
responde mal. Spec mini-P7 en Guacuco.

---

### Schema cache multi-instancia (Redis)

**Qué es**: hoy `schemaCache` es un `Map` in-process en el closure de
`makeFetchIntentNode`. Funciona bien con 1 instancia del agente.

**Por qué fuera de v1**: con múltiples instancias detrás de load balancer,
cada una hace su propio fetch al schema (≤1 vez por hora por instancia).
Volumen aceptable (~2-3 calls/hora por instancia).

**Cuándo reabrir**: si el deploy tiene >5 instancias O Guacuco reporta carga
del endpoint `/query-processor/tables` como problema.

---

## Plantilla para nuevos pendientes

```markdown
### <feature name>

**Qué es**: <descripción en 1-2 oraciones>.

**Referencia**: <path en IDP_OV1 o docs>.

**Por qué fuera de v1**: <razón concreta — esfuerzo, costo, complejidad,
falta de datos de producción para priorizar>.

**Cuándo reabrir**: <trigger concreto — métrica, evento de producción,
spec Guacuco lista>.
```
