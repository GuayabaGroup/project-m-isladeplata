# Plan H7 — Subgrafo `query` (text-to-data)

> Diferente al patrón slot-filling de H4/H5/H6. Responde preguntas informativas del usuario consultando datos. Es un grafo más simple (1 turno típicamente, sin interrupts en el happy path) pero con dos call sites LLM (genera SQL + sintetiza respuesta) — donde se usa **Sonnet** por primera vez en el proyecto.
>
> Pre-requisitos: H6 (o paralelo a H6 si los recursos lo permiten — no comparten código).

---

## 0. Contexto

El usuario pregunta cosas como:
- "¿Cuánto cuesta un corte?"
- "¿Qué horarios tengo el viernes?" (staff)
- "¿Qué servicios ofrecen?"
- "¿Tengo turnos esta semana?"
- "¿Cuándo es mi próximo turno?"

Estas son queries sobre datos del negocio (servicios, staff, appointments, schedules). Hay dos approaches:

**Opción A — Text-to-SQL** (heredado de IDP v2 §9.3 `QUERY_SQL_MODEL = Sonnet`):
- Genera SQL contra un schema dinámico (vía Guacuco), ejecuta, sintetiza respuesta.
- Flexible: cubre preguntas arbitrarias.
- Riesgoso: alucinación de columnas/tablas, costo Sonnet, SQL injection si no se valida.

**Opción B — Predefined intents + Guacuco calls**:
- 5-10 intents predefinidos ("get_service_prices", "get_my_upcoming", "get_staff_schedule"), cada uno con un endpoint Guacuco dedicado.
- Más seguro y rápido.
- Menos flexible — preguntas ad hoc fallan ("¿quién tiene más clientes este mes?").

**Recomendación v1**: **Opción B con fallback a A**.

- Implementar 5 intents fijos cubriendo el 80% de casos comunes.
- Si el classifier no matchea ningún intent fijo + confidence > umbral → Opción A (Sonnet SQL gen).
- Si confidence baja en ambos paths → "no pude responder eso, ¿podés reformular?".

Esto cierra la mayoría del valor con poco código y mantiene la puerta abierta a queries arbitrarias para usuarios power.

---

## 1. State del subgrafo

```typescript
export interface QueryDraftState {
  /** Texto sanitizado del usuario (input al subgrafo). */
  userText: string;
  /** Intent detectado (uno de los fijos o 'freeform_sql'). */
  detectedIntent?: 'service_prices' | 'my_upcoming' | 'staff_schedule_day' | 'service_list' | 'business_hours' | 'freeform_sql';
  /** Confidence del classifier interno (0-1). */
  confidence?: number;
  /** Raw result de Guacuco call (intent fijo) o SQL query (freeform). */
  rawResult?: unknown;
  /** Para freeform_sql: la SQL generada por Sonnet (para audit log + Sentry trace). */
  generatedSql?: string;
  phase: 'classifying' | 'fetching' | 'synthesizing' | 'done' | 'failed';
}
```

No hay slots — query es read-only y rápida.

---

## 2. Mapa del subgrafo

```
                  ┌──────────────────┐
                  │ entry            │ sanitize text
                  └────────┬─────────┘
                           │
                  ┌────────▼─────────┐
                  │ classify_query   │ Haiku — intent fijo vs freeform
                  └────────┬─────────┘
                           │
                  ┌────────▼─────────┐
                  │ intent_router    │ conditional edge
                  └─┬───────────────┬┘
        intent fijo │               │ freeform_sql
                    │               │
       ┌────────────▼──────────┐   │
       │ fetch_via_guacuco_    │   │
       │ tool (1 de 5)         │   │
       └────────────┬──────────┘   │
                    │               │
                    │   ┌───────────▼────────────┐
                    │   │ generate_sql           │ Sonnet
                    │   │ (con schema dinámico)  │
                    │   └───────────┬────────────┘
                    │               │
                    │   ┌───────────▼────────────┐
                    │   │ validate_sql           │ heurístico: solo SELECT,
                    │   │                        │ no DROP/UPDATE/DELETE,
                    │   │                        │ tablas en whitelist
                    │   └───────────┬────────────┘
                    │               │
                    │   ┌───────────▼────────────┐
                    │   │ execute_sql (Guacuco   │
                    │   │ endpoint protegido)    │
                    │   └───────────┬────────────┘
                    │               │
                    └───────┬───────┘
                            │
                  ┌─────────▼────────┐
                  │ synthesize_      │ Haiku — genera respuesta natural
                  │ response         │
                  └────────┬─────────┘
                           │
                         EXIT (outcome.response)
```

---

## 3. Componentes

### 3.1 `classify_query` (Haiku)

LLM con prompt:
```
Sos un clasificador de preguntas para un agente de turnos.
Devolvé JSON: {intent, confidence}.

intent es uno de:
- 'service_prices' — "cuánto cuesta {servicio}", "precios"
- 'my_upcoming' — "qué turnos tengo", "cuándo es mi próximo"
- 'staff_schedule_day' — "qué turnos tengo el {día}" (solo staff)
- 'service_list' — "qué servicios ofrecen"
- 'business_hours' — "qué horario tienen", "están abiertos los domingos"
- 'freeform_sql' — preguntas que no encajan en los anteriores
- 'cannot_answer' — la pregunta no es sobre el negocio

Si role=client, NO clasifiques como staff_schedule_day.
```

Fail-open a `cannot_answer` si parsing falla.

### 3.2 Tools fijas (`fetch_via_guacuco_*`)

Cada intent fijo mapea a un endpoint Guacuco específico. Listado:

| Intent | Guacuco call | Required Guacuco endpoint |
|---|---|---|
| `service_prices` | `executeTool('list_services_with_prices', {})` | **Verificar si existe**. Si no, usar `helpersLists` del identity resolve directamente. |
| `my_upcoming` | Lectura de `state.crmContext.upcomingAppointments` (ya cargado) | Ya disponible — no es call, es lookup. |
| `staff_schedule_day` | `executeTool('get_staff_appointments_summary', {date_start, date_end})` | Existe en IDP v2 — confirmar shape en Guacuco. |
| `service_list` | Lookup en `state.crmContext.helpersLists` | Ya disponible. |
| `business_hours` | `executeTool('get_business_hours', {})` | **Verificar si existe**. Si no, mini-spec P7 en Guacuco. |

**Verificación temprana en H7.1**: confirmar qué endpoints están + abrir specs faltantes.

### 3.3 `generate_sql` (Sonnet)

Solo para `freeform_sql`. Usa `SUBGRAPH_REASONING_MODEL=Sonnet` (heredado §11.2 REGLAS).

Prompt:
```
Sos un generador SQL para una BD Postgres de un negocio de turnos.
Schema dinámico (te lo paso abajo) — usá SOLO las tablas y columnas
listadas. NO inventes columnas.

Tenant context: business_uuid={{tenantUuid}}. SIEMPRE filtrá por este
business_uuid en la cláusula WHERE.

Reglas:
- Solo SELECT (no INSERT/UPDATE/DELETE/DROP).
- LIMIT 50 obligatorio.
- Si no podés generar SQL válida para la pregunta, devolvé {error: 'cannot_answer'}.

Devolvé JSON: {sql, params?}
```

Schema dinámico viene de Guacuco vía endpoint `GET /query/schema?business_uuid=...`. **Verificar si existe** — sino, agregar spec.

### 3.4 `validate_sql`

Función pura. Aplica reglas:

- Parse SQL (regex o `node-sql-parser` lib).
- Verifica que es solo `SELECT` (rechaza `DROP|UPDATE|DELETE|INSERT|ALTER|TRUNCATE|GRANT|REVOKE`).
- Verifica que las tablas estén en whitelist (del schema returned por Guacuco).
- Verifica que `WHERE business_uuid = $1` (o equivalente) está presente — para tenant isolation. **No negociable** (§5 REGLAS).
- Verifica `LIMIT <= 50`.

Si falla cualquier check → outcome `cannot_answer` + log `error` con SQL rechazada.

### 3.5 `execute_sql`

Llama un endpoint Guacuco protegido: `POST /query/execute` con `{sql, params, business_allia_id}`. Guacuco re-ejecuta sus validaciones internas y corre la query con un pool read-only.

**Punto crítico de seguridad**: Guacuco DEBE rechazar la SQL si rompe tenant isolation, aunque ya la validamos antes. Defense in depth. Esto puede requerir **spec P8** en Guacuco (endpoint dedicado de query con re-validation).

Alternativa más segura si P8 no está: **scope-out `freeform_sql` para v1**. Solo intents fijos. Es lo que recomendaría.

### 3.6 `synthesize_response` (Haiku)

LLM con prompt:
```
Sos un agente de atención al cliente. El usuario preguntó: "{{userText}}".
Acá está el dato:
{{rawResult JSON o tabla}}

Respondé en máximo 3 oraciones, tono amable. Si la lista es larga,
mencioná los primeros 5 con "y otros X".
```

Output: `{action: 'response', pendingReply: {text}}`.

---

## 4. Seguridad (crítico)

Heredado §13 REGLAS + §5 (no Postgres del negocio directo).

1. **Tenant isolation forzada**: toda SQL generada o intent fijo DEBE filtrar por `business_uuid` del state.identity. Si el LLM intenta saltarlo, `validate_sql` rechaza.
2. **Read-only**: Guacuco usa pool con usuario `PGUSER_READ_ONLY` (separado del operacional) — verificar que existe en Guacuco config.
3. **LIMIT 50** siempre — previene DoS por queries lentas.
4. **No mostrar SQL al usuario** — solo respuesta sintetizada. SQL en logs internos + LangSmith.
5. **PII en respuesta**: si la SQL devuelve teléfonos/emails de otros clientes, `synthesize_response` debe enmascararlos. **Riesgo alto**. Mitigación: el schema expuesto a Sonnet NO incluye columnas PII (filtrar en Guacuco antes de devolver el schema).

---

## 5. Plan de implementación (sub-hitos)

### H7.1 — Verificación de endpoints + classify_query + intents fijos simples

| Entregable | Detalle |
|---|---|
| Verify Guacuco endpoints | Confirmar qué endpoints existen para los 5 intents fijos. Abrir specs P7+ por los faltantes. |
| `src/graph/subgraphs/query/state.ts` | `QueryDraftState` |
| `src/graph/subgraphs/query/nodes/entry.ts` + `classify_query.ts` | Sanitize + Haiku classifier |
| `src/graph/subgraphs/query/nodes/intent_handlers/*.ts` | 3 intents triviales primero: `service_prices`, `my_upcoming`, `service_list` (lookups directos del state) |
| `synthesize_response.ts` | Haiku |
| Tests | 4 tests: cada intent + cannot_answer |

### H7.2 — Intents que requieren Guacuco call

| Entregable | Detalle |
|---|---|
| `intent_handlers/staff_schedule_day.ts` + `business_hours.ts` | Guacuco calls |
| Tests | 2 tests con GuacucoClient mockeado |

### H7.3 — `freeform_sql` (opcional, depende de Guacuco) — **scope-out si P8 no está**

| Entregable | Detalle |
|---|---|
| `generate_sql.ts` + `validate_sql.ts` + `execute_sql.ts` | Stack completo |
| Tests | SQL válida, SQL inválida (DROP), tenant violation, LIMIT missing |

### H7.4 — Wire + tests E2E

| Entregable | Detalle |
|---|---|
| `compile.ts` subgrafo + wire en supervisor | Reemplaza placeholder H3.B |
| Tests E2E | 5 queries comunes via grafo completo con MemorySaver |

### H7.5 — Documentación

| Entregable | Detalle |
|---|---|
| Update SPRINT.md + CLAUDE.md | H7 ✅ |

---

## 6. Tests críticos

1. **Intent `service_prices`** → "cuánto cuesta corte" → lookup helpersLists + synthesize.
2. **Intent `my_upcoming`** → "tengo turnos?" → lookup crmContext + synthesize.
3. **Intent `staff_schedule_day` para staff** → "qué tengo el viernes" → Guacuco call + synthesize.
4. **Intent `staff_schedule_day` para client** → rechazado por filterTools (no tiene permiso) → fallback social.
5. **Pregunta off-topic** → "cómo está el clima" → cannot_answer → respuesta amable.
6. **(Si freeform_sql implementado)** SQL válida → execute + synthesize.
7. **(Si freeform_sql implementado)** SQL con tenant violation → validate_sql rechaza, outcome cannot_answer + Sentry capture.

---

## 7. Decisiones a fijar antes de codear

| # | Decisión | Recomendación |
|---|---|---|
| 1 | ¿`freeform_sql` se implementa en v1? | **Depende de P8** en Guacuco. Si no está → scope-out. Mejor entregar 5 intents fijos sólidos que un freeform riesgoso. |
| 2 | ¿`synthesize_response` recibe el historial conversacional? | **No** v1 — la respuesta es atómica, no necesita memoria. |
| 3 | ¿Cap de tokens al raw result que se pasa a synthesize? | **Sí**, ~2000 tokens. Si excede, truncar y agregar "y X más" en el prompt. |
| 4 | ¿Caché de queries comunes (`service_prices` por business)? | **Sí**, Redis TTL 5min. Reduce calls a Guacuco. |
| 5 | ¿Si Guacuco devuelve 0 rows (sin servicios definidos, sin upcomings)? | Respuesta amable según contexto ("No tenés turnos próximos", "Aún no hay servicios cargados"). |

---

## 8. Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Endpoints Guacuco para los 5 intents no existen | Media | Verificación temprana H7.1. Abrir specs P7+ con tiempo. |
| `freeform_sql` alucina columnas inexistentes | Alta | `validate_sql` con whitelist estricta. `synthesize_response` recibe `null`/`error` si la SQL falló ejecutar — degrada amablemente. |
| Tenant isolation rota por LLM | Media | Doble validación (validate_sql + Guacuco re-checking) + tests específicos + log Sentry. |
| PII leak en respuesta sintetizada | Media | Schema expuesto a Sonnet sin columnas PII. Maskeo en `synthesize_response` como red de seguridad. |
| Costo Sonnet excesivo (freeform usa Sonnet) | Baja | Si scope-out freeform v1, no aplica. Si se incluye, cap por business + alerting en Sentry. |

---

## 9. Referencias

- [`docs/REGLAS_ISLADEPLATA.md`](./REGLAS_ISLADEPLATA.md) §5 (no Postgres directo), §11 (Sonnet para SQL), §13 (seguridad)
- Memoria [[reference-guacuco-endpoints]] — qué hay disponible
- IDP v2 — referencia heredada del patrón `QueryEngine + QueryJudge + QueryResultFormatter`
