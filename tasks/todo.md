# TODO — P3 + P4 (aislamiento WhatsApp: rol/profileType + consistencia de config)

Sistema: `--i` (Isladeplata). Framework de auditoría: `docs/REGLAS_ISLADEPLATA.md`.

## Contexto
Del análisis de aislamiento platformId/owner/staff:
- **P3** — No hay cross-check entre `channelMeta.role` (línea WA entrante) y
  `identity.profileType` (Guacuco). Riesgo: responder desde una línea y procesar
  con tools/schema del rol opuesto → cruce de información. (REGLAS §12.2)
- **P4** — `channels.config.ts` no valida al boot: (a) unicidad de `(role, platformId)`
  para el outbound first-match; (b) que cada `platformId` del channel map tenga
  `app_secret`. (REGLAS §3 bootstrap fail-fast, §13.1)

## Decisión de diseño (owner, 2026-05-28)
- P3: **fail-closed** — divergencia ⇒ `logger.warn` + Sentry + outcome `ignored`
  (silent skip). No se sirve el turno con el contexto equivocado.
- P4: **fail-fast al boot** (throw `IdpError('invalid_env', ...)` al cargar el módulo),
  consistente con `parseChannelMap`. La cobertura de app_secret se omite si
  `WHATSAPP_SKIP_SIGNATURE=true` (dev sin secrets, según `env.ts`).

## Tareas

### P4 — `src/config/channels.config.ts`
- [ ] `validateChannelConsistency(channelMap, appSecretMap, skipSignature)` exportada y pura (testeable).
  - [ ] (role, platformId) único ⇒ throw `IdpError('invalid_env', ...)` con ambos phoneNumberIds.
  - [ ] `!skipSignature` ⇒ todo platformId del map tiene secret ⇒ throw si falta.
- [ ] Invocarla a module-load tras construir ambos maps (pasar `env.WHATSAPP_SKIP_SIGNATURE`).
- [ ] Test `tests/unit/config/channels.config.test.ts` (happy + duplicado + secret faltante + skip).

### P3 — `src/pregraph/pipeline.ts`
- [ ] Guard tras `toInternalIdentityOrNull` (antes de thread/takeover/rate-limit):
      si `message.channelMeta?.role` existe y `!== internalIdentity.profileType`
      ⇒ warn + `captureIdpError` + `roleProfileMismatchTotal.inc()` + return `{ action: 'ignored' }`.
- [ ] `src/infrastructure/observability/metrics.ts`: counter `roleProfileMismatchTotal` (label `channel`) + reset.
- [ ] Test en `tests/unit/pregraph/pipeline.test.ts`: mismatch ⇒ ignored, grafo NO invocado, warn llamado.

### Verificación
- [x] `pnpm typecheck` ✓
- [x] `pnpm test` ✓ (787, +9)
- [x] `pnpm lint` ✓ (241 files)
- [x] Auditoría REGLAS_ISLADEPLATA (post-impl) ✓

## Review

**Estado**: completo. P3 (fail-closed) + P4 (fail-fast boot) implementados y verificados.

**Archivos**:
- `src/config/channels.config.ts` — `validateChannelConsistency()` (pura, exportada) + llamada a module-load.
- `src/infrastructure/observability/metrics.ts` — counter `roleProfileMismatchTotal{channel}` + reset.
- `src/pregraph/pipeline.ts` — guard 4.1 (rol↔profileType) + import `IdpError`.
- `tests/unit/config/channels.config.test.ts` (nuevo, 6) + `tests/unit/pregraph/pipeline.test.ts` (+3).

**Decisión de no-persistencia (P3)**: el turno con mismatch retorna `ignored` SIN persistir
(a diferencia de rate-limit/takeover que sí persisten). Persistir escribiría historial
contra un tenant/perfil sospechoso — exactamente el cruce que el guard previene. Se trata
como silent skip de seguridad, análogo a identity-not-found.

**Verificación**: typecheck ✓ · lint ✓ · 787 tests ✓ (+9: 6 config + 3 pipeline).
