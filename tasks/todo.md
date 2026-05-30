# Fix: botón de template "Resumen del cliente" (staff) no funciona (--i)

**Flag:** `--i` (Isladeplata). `--g` NO aplica: el handler `send_client_summary`
(`SendClientSummaryToolHandler`) ya existe y funciona en Guacuco.
**Fecha:** 2026-05-30.

## Diagnóstico (root cause)
El feature `send_client_summary` estaba cableado en el IDP legacy
(`project-m-idp/src/conversation/TemplateButtonHandler.ts` → mapeo
`'resumen del cliente' → send_client_summary`), pero **no fue portado al rewrite
isladeplata**. El título "Resumen del cliente" no matchea `TITLE_ACTION_MAP` en
`buttonShortcut.ts` (solo cancelar/confirmar/reagendar), el fallback por prefijo
del payload tampoco → `buttonShortcut=null` → el turno cae al classifier LLM, que
lo clasifica como saludo → respuesta genérica de onboarding (la traza reportada).

## Cambios
- [ ] 1. `buttonShortcut.ts`: kind `client_summary` + entrada `/resumen del cliente/i` en `TITLE_ACTION_MAP`
- [ ] 2. `core/enums/GuacucoToolName.ts`: `SEND_CLIENT_SUMMARY: 'send_client_summary'`
- [ ] 3. `clients/types/GuacucoTypes.ts`: `SendClientSummaryResult`
- [ ] 4. `clients/GuacucoClient.ts`: `sendClientSummary(appointmentRef, identity)`
- [ ] 5. `supervisor/filterTools.ts`: `send_client_summary` en `ToolName` + STAFF_OWNER_TOOLS + STAFF_TOOLS_FALLBACK (staff-only, igual que legacy)
- [ ] 6. `tools/system/sendClientSummary.ts`: tool atómica (uuid resuelto del shortcut, fallback al wamid contextMessageId; gate `isToolAllowed`)
- [ ] 7. `compile.ts`: nodo `tool_send_client_summary` + edge a END + ruteo del tap `client_summary` en `supervisorEntryRouter`
- [ ] 8. `pnpm typecheck` (vigilar TS2589 por techo de nodos) + `pnpm lint`
- [ ] 9. Tests unit (buttonShortcut + tool)
- [ ] 10. Auditoría REGLAS_ISLADEPLATA

## Review
- `buttonShortcut.ts` — kind `client_summary` + `/resumen del cliente/i` en `TITLE_ACTION_MAP`.
  El payload del quick-reply es el título estático; el uuid real lo resuelve después
  `supervisorEntryNode` vía `resolveTemplateAppointmentUuid` (mismo flujo que cancel/confirm).
- `GuacucoToolName.ts` — `SEND_CLIENT_SUMMARY`.
- `GuacucoTypes.ts` — `SendClientSummaryResult`.
- `GuacucoClient.ts` — `sendClientSummary(appointmentRef, identity)`; acepta uuid **o** wamid
  (Guacuco resuelve por `template_send_log`), igual que el legacy.
- `filterTools.ts` — `send_client_summary` en `ToolName` + STAFF_OWNER_TOOLS + STAFF_TOOLS_FALLBACK
  (staff-only, paridad con el legacy `toolAccess.ts`).
- `tools/system/sendClientSummary.ts` — tool atómica single-turn (solo botón, sin path por texto).
  Lee el uuid resuelto del shortcut, fallback al `contextMessageId`; gate `isToolAllowed`;
  fail-safe §9.4 (sin permiso / sin ref / fallo backend → outcome neutro, nunca lanza).
- `compile.ts`:
  - Ruteo del tap `client_summary` desde `supervisorEntryRouter` → `tool_send_client_summary`.
  - **TS2589 (techo de nodos)**: el nodo nuevo desbordaba la profundidad de instanciación de
    tipos del chain `.addNode`. Solución: **colapsar los 5 nodos `*_finalize`** (todos
    registraban la MISMA `subgraphFinalize`) en un único `subgraph_finalize`. Los routers NO
    cambian — siguen devolviendo las keys `*_finalize`, remapeadas al nodo compartido en los
    conditional-edge maps. Net: 48 → 45 nodos. Seguro: 1 subgrafo activo por turno → 1 arista
    entrante; handler genérico (`__kind`).

**Verificación**: `pnpm typecheck` ✓ · `pnpm lint` (257 files) ✓ · `pnpm test` 868 ✓
(7 nuevos de `sendClientSummary`, +1 buttonShortcut; el integration `compile.test.ts` valida el
finalize colapsado en runtime). Sin tocar Guacuco (`--g` no aplica: el handler ya existía).

## Auditoría REGLAS_ISLADEPLATA
- §6 (HTTP clients): método nuevo vía `executeTool` + `toolContextFromIdentity` + enum
  `GUACUCO_TOOLS`, sin axios directo. ✓
- §10.5 (filtrado por rol): `isToolAllowed` consumido en la tool (defense-in-depth; más estricto
  que confirm/cancel/reschedule, que no gatean en router). ✓
- §10.6 (side-effect solo en commit): `send_client_summary` es READ-only → válido como tool
  atómica (igual que `get_staff_appointments_summary`/`retrieve_manzanillo_url`). ✓
- §13.4 (logging): contexto estructurado, sin PII (no se logea el message con teléfono). ✓
- §15.2/15.3 (naming/1-componente-1-archivo): `sendClientSummary.ts` camelCase, un export +
  helpers privados (patrón idéntico a `forwardMessage.ts`). ✓
- §2 (dependencias): tool→filterTools dentro de `graph/`, sin ciclo. ✓
- §4 (TS strict / `.js` / zero `any` / `import type`): ✓
