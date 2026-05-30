# Fix: turno 2 re-emite la respuesta del turno 1 (outcome stale del checkpoint)

**Flags:** `--i` (Isladeplata). `--g` no aplica: la causa es 100% del grafo de IDP, no de Guacuco.
**Fecha:** 2026-05-30

## Síntoma reportado (escenario incorrecto)
Staff Juan (HappyPawsG, platformId 2, thread `...:whatsapp:2`):
- Turno 1 — "Hola" → "¡Hola! Soy Groomy... ¿Necesitás agendar un turno, consultar...?" ✅
- Turno 2 — "Cuantos turnos tengo esta semana?" → **el mismo saludo, byte-por-byte** ❌

El saludo idéntico (2 generaciones LLM a temp 0.7 no pueden coincidir byte-a-byte) delata que el
turno 2 **no generó nada nuevo**: re-despachó el `outcome` del turno 1.

## Causa raíz (confirmada leyendo el código)
`outcome` es un canal **persistido en el checkpoint** y **nunca se resetea entre turnos**.
El pre-grafo re-pasa `input/identity/crmContext/catalog/recentTemplates` en cada invoke fresh
(`pipeline.ts:349-358`) justo para sobreescribir valores stale — **pero NO pasa `outcome`**.

Turno 2 (invoke fresh, no-resume):
1. El checkpoint todavía tiene `outcome` = saludo del turno 1.
2. `supervisorEntryNode` (texto normal) retorna `{}` → no toca `outcome`.
3. `supervisorEntryRouter` (`compile.ts:539-540`): `if (state.outcome) return 'unsupported_end'`
   — asume que `outcome` solo lo setea el fast-path de contenido no soportado **de este turno**.
   El `outcome` stale es truthy → cortocircuita a `END`.
4. El grafo termina **sin clasificar ni escribir un outcome nuevo**.
5. `outcomeFromResult` (`pipeline.ts:550`) devuelve `graphResult.outcome` = saludo turno 1 → re-despacho idéntico.

Impacto: **cualquier** 2º mensaje de texto en un thread no expirado cuyo turno previo cerró por
fast-path/social/subgrafo (todos dejan `outcome` seteado) re-emite la respuesta anterior.

## Fix (mínimo, alineado a §8.2 — el supervisor es owner de `outcome` en fast-paths/apertura de turno)
Resetear `outcome` al abrir cada turno en el nodo de entrada del supervisor, ANTES de que el router
lo lea. El fast-path de contenido no soportado sigue seteando su propio outcome (override del null).

- [ ] `src/graph/compile.ts` — `supervisorEntryNode`: en todas las ramas salvo la de contenido no
      soportado, incluir `outcome: null` en el update (reset del valor stale del checkpoint).
      La rama de subgrafo activo conserva `subgraphState` (no se resetea), solo limpia `outcome`.
- [ ] `src/graph/compile.ts` — actualizar comentarios de `supervisorEntryNode`/`supervisorEntryRouter`
      (el `outcome` que ve el router solo puede venir del fast-path de ESTE turno tras el reset).

## Verificación
- [ ] Regresión en `tests/unit/graph/compile.test.ts`: dos invokes en el **mismo** `thread_id`
      (MemorySaver) — turno 1 greeting, turno 2 pregunta distinta. Assert: outcome del turno 2 ≠ turno 1
      y el classifier corrió en el turno 2 (no se cortocircuitó a END).
- [ ] `pnpm test` (suite completa) + `pnpm typecheck` + `pnpm lint` verdes.

## Nota secundaria (NO se arregla acá; se reporta como follow-up)
Aun con el outcome arreglado, "cuántos turnos tengo **esta semana**" para staff tiene cobertura
parcial: `staff_schedule_day` solo trae HOY (`fetchIntent.ts:162`) y el hint staff del clasificador
global (`classifyIntent.ts:82-86`) no menciona consultas de la propia agenda. Queda como follow-up
de calidad de respuesta, separado de este bug de re-emisión.

## Review
- `src/graph/compile.ts` — `supervisorEntryNode`: agregado `const turnReset = { outcome: null }`,
  esparcido en las ramas de subgrafo activo / button / atomic tool / default. La rama de media
  conserva su `return { outcome: unsupported }`. Comentarios de nodo y router actualizados.
- `tests/unit/graph/compile.test.ts` — nuevo test de regresión "second turn on same thread does NOT
  re-emit the previous turn outcome" (dos invokes mismo thread_id; verifica que el classifier corre
  en el 2º turno y que el outcome cambia).

**Verificación**: `pnpm typecheck` ✓ · `pnpm lint` (255 files) ✓ · `pnpm test` 838 ✓ (compile.test.ts 10/10).

## Audit Results — REGLAS_ISLADEPLATA.md
- **§8.2 Ownership de state** ✓ — `outcome` lo escribe el supervisor (apertura de turno + fast-paths),
  consistente con la tabla (`subgrafo al cerrar / supervisor en fast-paths`). No se mutan bloques de
  otro owner: el reset toca solo `outcome`; la rama de subgrafo activo NO resetea `subgraphState`.
- **§Inmutabilidad de nodos** ✓ — el nodo retorna un `Partial<GraphStateUpdate>`; el reducer
  `replaceWith` aplica el `null`. No hay mutación in-place del state.
- **§2 Dirección de dependencias** ✓ — sin imports nuevos; sin `pg`/`axios`/SDK directo; cambio
  contenido en `graph/`.
- **Naming / dead code** ✓ — `turnReset` camelCase, usado en 4 retornos; sin imports ni vars muertas.
- **§13 Seguridad/logging** ✓ — sin secretos, sin SQL, sin PII nueva logueada.
- **Testing (Vitest, fuera del source)** ✓ — regresión en `tests/unit/`, imports explícitos desde vitest.

Sin violaciones. No se tocó Guacuco (`--g` no aplicaba: bug 100% del grafo IDP).
