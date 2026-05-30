# PLAN D — Subgrafos compilados por separado (compose)

**Objetivo:** eliminar el techo `TS2589` **de raíz**, no comprar runway. Hoy `compile.ts`
arma un único `StateGraph` con ~39 nodos en una cadena `.addNode()…`; TS acumula el union de
nombres de nodo y revienta cerca de ~48. Si cada subgrafo se compila como **su propio
`StateGraph`** y se monta en el parent como **un solo nodo compilado**, el parent baja a ~15
nodos y cada subgrafo tiene **su propio presupuesto de tipos**. El TS2589 deja de ser una
restricción al agregar features.

**Flag:** `--i` (Isladeplata). Sin `--g` (no toca contratos Guacuco). Refactor interno del grafo.

**Estado:** PROPUESTA. No empezar a implementar sin completar la Fase 0 (spike) y aprobar.

---

## 1. Resultado esperado

### Parent graph (después): ~15 nodos
```
supervisor_entry, classify_intent, social_responder, subgraph_placeholder,
tool_retrieve_manzanillo_url, tool_generate_verification_url, tool_connect_mercado_pago,
tool_send_client_summary, tool_forward_message,
schedule (compiled), confirm (compiled), cancel (compiled),
reschedule (compiled), query (compiled)
```
Cada `(compiled)` es un `StateGraph` aparte con sus 5–10 nodos internos. Total de nodos del
parent: 14–15. Headroom efectivamente ilimitado para tools/subgrafos nuevos.

### Qué desaparece del parent
- El canal `subgraphState` + `subgraphReducerDispatch` (el reducer discriminado por `__kind`).
- Los wrappers `wrapSchedule` / `wrapScheduleAsync`.
- Los nodos `subgraph_dispatch`, `subgraph_gate`, `subgraph_finalize` (su lógica se reubica
  dentro de cada subgrafo o en el borde parent↔subgrafo).
- Los ~20 `routeAfter*` del parent (pasan a vivir dentro de cada subgrafo compilado).

---

## 2. EL riesgo que define el plan: interrupt/resume anidado

Hoy (inlineado), `askSlot`/`gate`/`present` llaman `interrupt()` y pausan el parent. El
pre-grafo (`pipeline.ts`) depende de DOS cosas que hay que **revalidar** con subgrafos anidados:

1. **Detección** (`detectPendingInterrupts`): hace
   `graph.getState(...).tasks.some(t => t.interrupts.length > 0)`. **Pregunta abierta:** cuando
   el interrupt ocurre dentro de un subgrafo compilado, ¿aflora en `tasks[].interrupts` del
   **parent**, o queda en el state anidado del subtask? En LangGraph JS los interrupts de
   subgrafos propagan hacia arriba, pero la forma exacta en `getState().tasks` del parent (vs.
   `getState(..., subgraphs: true)`) hay que verificarla empíricamente.
2. **Reanudación** (`Command(resume=payload)`): hoy reanuda el parent y `interrupt()` retorna el
   payload en el nodo pausado. Con anidamiento, `Command(resume)` debe enrutar el valor al
   **subtask** correcto. Verificar que un solo `Command(resume)` plano (sin namespacing manual)
   alcanza al subgrafo interrumpido.
3. **Checkpointer compartido**: los subgrafos se compilan **sin** su propio checkpointer →
   heredan el del parent (mismo `thread_id`). Verificar que el resume reconstruye el subtask.

> Si (1)/(2) no funcionan con un `Command(resume)` plano, el plan NO se cae, pero cambia: el
> pre-grafo debe pasar `{ subgraphs: true }` a `getState` y/o namespacing del resume. Eso se
> decide en la Fase 0, no a ciegas.

---

## 3. Diseño de state (borde parent ↔ subgrafo)

LangGraph mapea canales entre parent y subgrafo **por nombre**. Diseño propuesto:

- **Canales compartidos (read en el subgrafo):** `identity`, `catalog`, `crmContext`,
  `recentTemplates`, `input` — mismas `Annotation` que el parent → se mapean solos.
- **Canales compartidos (write desde el subgrafo):** `outcome`, `messages` — el subgrafo escribe
  el outcome final y appendea historial directamente. Esto **reemplaza** a `subgraph_finalize`.
- **Estado privado del subgrafo (draft):** vive SOLO en el schema del subgrafo, no en el parent.

### Decisión clave de churn: cómo nombrar el draft dentro del subgrafo
Los ~30 node fns hoy leen `state.subgraphState.slots/phase/meta`. Dos opciones:

- **D-min (menor churn, recomendada):** el schema de cada subgrafo conserva un canal llamado
  `subgraphState` (tipado a SU draft concreto, con SU reducer — el `scheduleSubgraphReducer`
  etc., ya existen). Los node fns **no cambian** (siguen leyendo `state.subgraphState`). El
  parent deja de tener `subgraphState`. Se elimina solo el **dispatcher** de reducers, no los
  reducers por-subgrafo.
- **D-clean (más churn, más legible):** promover `slots/phase/meta` a canales top-level del
  subgrafo y reescribir los node fns a `state.slots`. Más prolijo pero toca 30 archivos.

→ **Adoptar D-min.** La meta es matar el TS2589 con el mínimo de superficie tocada; la limpieza
de nombres puede ser un follow-up opcional.

### Init + preseed (lo que hoy hace `subgraph_dispatch`)
Mover a un **nodo `bootstrap`/`entry` interno** de cada subgrafo (la mayoría ya tiene uno).
La derivación de "a qué subgrafo ir" se queda en el parent: el router del supervisor enruta
directo al **nodo del subgrafo compilado** (`schedule`/`confirm`/…). El preseed del slot de cita
(desde `buttonShortcut`) se hace en el `entry` del subgrafo leyendo `routing.buttonShortcut`.

---

## 4. Fases

### Fase 0 — SPIKE de validación (GATE, no se salta)
Objetivo: responder las 3 preguntas de §2 con código real **antes** de migrar nada.
- [ ] Crear un subgrafo de juguete compilado con 1 `interrupt()`, montarlo como nodo en un
      parent mínimo con el `PostgresSaver` real (mismo checkpointer que prod).
- [ ] Verificar: `parent.getState()` tras el interrupt → ¿`tasks[].interrupts` no vacío? Si no,
      probar `getState(cfg, { subgraphs: true })` y ajustar `detectPendingInterrupts`.
- [ ] Verificar: `parent.invoke(new Command({ resume }))` reanuda el subgrafo y `interrupt()`
      retorna el payload.
- [ ] Verificar: `__interrupt__` aflora en el resultado del `invoke` del parent (lo usa
      `outcomeFromResult`).
- [ ] **Entregable:** nota de 1 página con el contrato confirmado (qué firma exacta tienen
      `getState`/`Command`/resultado con subgrafos) + decisión go/no-go. Si no-go: quedarse con
      A+B+finalize (runway) y cerrar D.

### Fase 1 — `query` primero (subgrafo SIN interrupt → riesgo mínimo)
`query` no llama `interrupt()` (classify → fetch → synthesize → fin). Es el caso ideal para
validar el **mecanismo de compose** sin el riesgo de resume.
- [ ] Crear `src/graph/subgraphs/query/graph.ts`: `buildQueryGraph(deps)` → `StateGraph` propio
      (schema: shared reads + `outcome`/`messages` write + draft privado) compilado SIN
      checkpointer.
- [ ] Mover `query_classify`/`query_fetch`/`query_synthesize` + sus `routeAfter*` adentro.
- [ ] El nodo terminal del subgrafo escribe `outcome` (+ `messages`) directamente (reemplaza el
      finalize para query).
- [ ] En `compile.ts`: `.addNode('query', buildQueryGraph(deps))`; el router enruta a `'query'`.
- [ ] Borrar del parent los nodos/edges/routers de query.
- [ ] Verde: `query.e2e.test.ts` (12 tests) sin cambios de aserción.

### Fase 2 — `confirm` (el write más simple; interrupt solo en `ask_slot`)
Primer subgrafo con `interrupt()`. Valida el contrato de la Fase 0 en un flujo real.
- [ ] `buildConfirmGraph(deps)` con bootstrap/ask_slot/commit/success internos.
- [ ] El `entry/bootstrap` hace el init + preseed (lo que hacía `subgraph_dispatch`).
- [ ] Ajustar `pipeline.ts` si la Fase 0 lo exigió (getState subgraphs / resume).
- [ ] Verde: `confirmCancel.e2e.test.ts` (la parte confirm) — happy path, 0 upcomings, N→pick,
      y el resume tras interrupt.

### Fase 3 — `cancel` y `reschedule` (gate + present + interrupt)
Los más complejos (build_confirm → gate → commit, present_options, validate con race-retry).
- [ ] `buildCancelGraph` / `buildRescheduleGraph` con todos sus nodos + routers internos.
- [ ] El gate (`interrupt()` de confirmación) y el present quedan internos.
- [ ] Verde: resto de `confirmCancel.e2e.test.ts` + `reschedule.e2e.test.ts`.

### Fase 4 — `schedule` (el más grande) + limpieza del parent
- [ ] `buildScheduleGraph` con los 8 nodos + routers.
- [ ] Eliminar del parent: canal `subgraphState`, `subgraphReducerDispatch`, `wrapSchedule`/
      `wrapScheduleAsync`, `subgraph_dispatch`/`subgraph_gate`/`subgraph_finalize` y todos los
      `routeAfter*`.
- [ ] `supervisorEntryRouter` / `routeFromSupervisorWithSubgraphs` enrutan directo a los nodos
      `schedule`/`confirm`/`cancel`/`reschedule`/`query`.
- [ ] Verde: `schedule/e2e.test.ts` + `compile.test.ts` + suite completa (868).

### Fase 5 — Cutover en producción (in-flight checkpoints)
Riesgo real: hay conversaciones **pausadas en un interrupt** checkpointeadas con la estructura
VIEJA (nombres de nodo viejos, `subgraphState` plano). Tras el deploy NO van a poder reanudar
contra la estructura nueva.
- [ ] Estrategia recomendada: **drain**. El TTL del checkpoint es corto (ver §7.3 REGLAS) →
      esperar 1 ventana de TTL tras congelar merges para que los threads activos expiren, y
      deployar en valle de tráfico. Documentar en `RUNBOOK_CUTOVER.md`.
- [ ] Alternativa si no se puede drenar: detectar en el pre-grafo un resume que falla por
      estructura incompatible → fallback a invoke fresh (el usuario re-explica; aceptable para
      la cola residual de interrupts).
- [ ] Observar 24–48h: tasa de resume fallido, `outcome.action`, errores Sentry del grafo.

---

## 5. Estrategia de testing
- Los **e2e por subgrafo** (`*.e2e.test.ts`) son la red de seguridad principal: ejercitan el
  grafo COMPILADO end-to-end con mocks de Guacuco/LLM. Cada fase no avanza sin su e2e verde.
- `compile.test.ts` (wiring del supervisor + no-reemisión de outcome stale) valida el parent.
- **Test nuevo de Fase 0:** un `tests/integration/subgraphCompose.spike.test.ts` que verifique
  interrupt/resume anidado con el checkpointer real (se mantiene como regression guard).
- No tocar aserciones existentes: si un e2e exige cambiar lo que el usuario recibe, es señal de
  regresión, no de "actualizar el test".

## 6. Rollback
- Cada fase es un commit aislado y reversible. Si la Fase N rompe, `git revert` de esa fase deja
  el grafo funcional (las fases previas ya migradas siguen compiladas).
- La Fase 0 es gate: si el spike es no-go, se cierra D sin tocar producción y se documenta por
  qué (quedando A+B como solución vigente).

## 7. Estimación (orden de magnitud)
| Fase | Esfuerzo | Riesgo |
|------|----------|--------|
| 0 — spike | 0.5 día | — (es el que mide el riesgo) |
| 1 — query | 0.5 día | bajo (sin interrupt) |
| 2 — confirm | 1 día | medio (primer resume anidado) |
| 3 — cancel+reschedule | 1.5 días | medio-alto (gate/present/race) |
| 4 — schedule + limpieza parent | 1.5 días | medio |
| 5 — cutover | 0.5 día + 24–48h observación | alto (in-flight) |

## 8. Criterio de éxito
- `pnpm typecheck`/`lint`/`test` verdes con el parent en ~15 nodos.
- Agregar un nodo nuevo de prueba al parent **ya no** dispara TS2589 (verificación explícita).
- Cero cambios de comportamiento observable (todos los e2e con aserciones intactas).
- Cutover sin spike de resume fallido en producción.

## 9. Decisión pendiente del usuario
- ¿Arrancamos por la **Fase 0 (spike)** para medir el riesgo de interrupt/resume anidado antes de
  comprometer el refactor? Es la única forma honesta de saber si D es viable con bajo costo.
