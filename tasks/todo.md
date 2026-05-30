# Fix: staff "resumen de mañana / X día" no invoca el tool de agenda (--i)

**Flags:** `--i` (Isladeplata). `--g` NO aplica: el contrato de Guacuco
(`getStaffAppointmentsSummary`) **ya soporta rango** (`date_start` + `date_end`, máx 31 días).
**Fecha:** 2026-05-30. Es el follow-up que la `todo.md` previa dejó anotado (Nota secundaria).

## Diagnóstico (root cause)

El tool existe y funciona: intent `staff_schedule_day` (subgrafo `query`) →
`guacuco.getStaffAppointmentsSummary({ date_start, date_end })`. El bug está 100% en IDP:

1. **`classifyQuery.ts` (SYSTEM_PROMPT_STAFF, L69):** define `staff_schedule_day` como
   *"agenda… de **HOY** (\"qué tengo hoy\", \"agenda\")"*. Al pedir **"resumen de mañana"** /
   "próxima semana" / "próximos 5 días", NO matchea (dice HOY) ni `my_upcoming` (= turnos
   propios como cliente) → cae en `cannot_answer` → *"No tengo acceso a tu calendario…"*.
   Es exactamente la traza reportada.

2. **`fetchIntent.ts` (caso `staff_schedule_day`, L162-168):** fecha hardcodeada a
   `{ date_start: today, date_end: today }`. Aun bien clasificado, nunca respondería "mañana".

El supervisor (`classifyIntent.ts`) sí rutea estos mensajes a `query` (la traza lo confirma).
Agrego igual 1 línea defensiva al `STAFF_QUERY_HINT` para robustez ante imperativos ("dame").

## Cambios

### 1. `src/graph/subgraphs/query/state.ts`
- [ ] `QueryDraftState`: agregar `scheduleRange?: { dateStart: string; dateEnd: string }`
      (lo resuelve classify, lo consume fetch). Reducer es spread genérico → se propaga solo.

### 2. `src/graph/subgraphs/query/nodes/classifyQuery.ts`
- [ ] `SYSTEM_PROMPT_STAFF` (const) → `buildStaffSystemPrompt(temporal)` (necesita fecha
      actual + día de semana). Reusar `buildTemporalContext` de `../prompts/querySql.js`.
- [ ] Ampliar `staff_schedule_day`: agenda de TRABAJO del staff para **cualquier día/rango**
      (hoy, mañana, fecha puntual, esta semana, próximos N días, finde). Aclarar vs `my_upcoming`.
- [ ] Cuando `intent="staff_schedule_day"`, pedir además `date_start`/`date_end` (YYYY-MM-DD)
      relativos a hoy. Default `hoy/hoy` si no se menciona fecha.
- [ ] `ClassifyOutput` += `dateStart?`/`dateEnd?`; `normalize` valida `^\d{4}-\d{2}-\d{2}$`,
      solo para `staff_schedule_day`; el nodo devuelve `scheduleRange`.

### 3. `src/graph/subgraphs/query/nodes/fetchIntent.ts`
- [ ] Caso `staff_schedule_day`: reemplazar `today` hardcodeado por
      `resolveScheduleRange(current.scheduleRange, timezone)` — valida formato, ordena
      (`start<=end`), clampea span ≤ 31 días, fallback `hoy/hoy`. Pasar a Guacuco.
- [ ] Incluir el rango resuelto en `rawResult`.

### 4. `src/graph/supervisor/classifyIntent.ts` (defensivo, 1 línea)
- [ ] `STAFF_QUERY_HINT`: agregar que preguntas del staff por su **propia agenda de trabajo**
      ("qué tengo hoy", "mi agenda", "resumen del día/de mañana") son `query`, no `action`.

### 5. Tests (`tests/unit/graph/subgraphs/query/nodes.test.ts`)
- [ ] Actualizar mocks staff del clasificador con `date_start/date_end`.
- [ ] classify: "resumen de mañana" → `staff_schedule_day` + `scheduleRange`.
- [ ] fetch: usa `scheduleRange` (mañana) en la call, no hoy.
- [ ] fetch: `scheduleRange` ausente → fallback hoy/hoy.
- [ ] fetch: span > 31 días → clamp.

## Verificación
- [ ] `pnpm typecheck` + `pnpm lint` limpios.
- [ ] `pnpm test` verde.
- [ ] Auditoría contra `docs/REGLAS_ISLADEPLATA.md`.

## Review
- `state.ts` — `QueryDraftState.scheduleRange?: { dateStart, dateEnd }` agregado.
- `classifyQuery.ts` — `SYSTEM_PROMPT_STAFF` → `buildStaffSystemPrompt(temporal)` (reusa
  `buildTemporalContext`); `staff_schedule_day` ahora cubre cualquier día/rango y el LLM
  devuelve `date_start/date_end`. `normalize` valida formato `YYYY-MM-DD` y solo conserva
  el rango para `staff_schedule_day`. El nodo emite `scheduleRange`.
- `fetchIntent.ts` — `resolveScheduleRange()` (valida formato, ordena, clampea ≤31 días,
  fallback hoy/hoy) reemplaza el `today` hardcodeado; rango incluido en `rawResult`.
- `classifyIntent.ts` — `STAFF_QUERY_HINT` + línea: agenda propia del staff = `query`.
- `tests/.../query/nodes.test.ts` — 6 tests nuevos (classify: scheduleRange mañana / sin
  fechas / descarta en otro intent; fetch: usa rango / fallback hoy / clamp 31d).

**Verificación**: `pnpm typecheck` ✓ · `pnpm lint` (255 files) ✓ · `pnpm test` 853 ✓
(query nodes 31/31). Sin tocar Guacuco (`--g` no aplica: el contrato ya soportaba rango).
