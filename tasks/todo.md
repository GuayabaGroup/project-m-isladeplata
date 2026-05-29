# Tarea: Contexto de templates enviados en el historial del agente (IDP)

**Flags:** `--i` (Isladeplata) · `--g` (Guacuco, solo consumo) · `--c` (verificación DB read-only)
**Fecha:** 2026-05-29

## Problema
Cuando IDP envía un template proactivo (S2S: Guacuco → IDP → WhatsApp; ej. recordatorio de turno 24h), ese mensaje **nunca entra al state del thread**. Al responder el usuario en texto libre ("sí dale", "no puedo ese día"), el `classifyIntent` del supervisor ve **solo ese texto** (sin historial, sin CRM, sin template) → rutea a ciegas (`oos`/`action:unknown`). Los taps de botón estructurados (`confirm:`/`cancel:`) ya se resuelven con `detectButtonShortcut`; el hueco son las **respuestas de texto libre** a templates.

## Backend (`--g`) — YA EXISTE, sin cambios
`GET /api/v1/template-send-log/recent?recipient_phone=…&window_hours=…&limit=…&status=sent` → `{ templates: RecentTemplateData[], count, window_hours }` (API-Key). Devuelve `template_name`, `parameters[]`, `created_at`, `metadata.platform_id`, `meta_message_id`, `user_type`. No requiere cambios — solo consumo + auditoría de compliance.

## Decisiones (confirmadas con el owner)
1. **State:** campo dedicado top-level `recentTemplates` en `GraphState` (replace-only, owned por pre-grafo).
2. **Scoping cross-platform:** filtro **client-side en IDP** por `metadata.platform_id` (+ `channel_phone_number_id` si está) contra `identity.platformId`. Cero cambios en Guacuco. (Defensa cross-tenant — memoria `feedback_idp_multibusiness_identity`.)
3. **Inyección:** `classifyIntent` + `socialResponder`.

## Plan de implementación (IDP)

### A. HTTP client (consumo del endpoint existente)
- [ ] `src/clients/types/GuacucoTypes.ts`: agregar `RecentTemplateRaw` (snake_case) + `GetRecentTemplatesInput`.
- [ ] `src/clients/mappers/RecentTemplateMapper.ts`: raw → camelCase, patrón `IdentityMapper`.
- [ ] `src/clients/GuacucoClient.ts`: método `getRecentTemplates(input): Promise<RecentTemplate[]>` → `GET /api/v1/template-send-log/recent`, unwrap vía `BaseHttpClient`, query params snake_case. Fail-soft a `[]` lo maneja el caller (pre-grafo), no el client.

### B. State
- [ ] `src/core/types/RecentTemplate.ts`: tipo puro `RecentTemplate` + `EMPTY_RECENT_TEMPLATES`.
- [ ] `src/graph/state.ts`: nuevo canal `recentTemplates: Annotation<RecentTemplate[]>` con `reducer: replaceWith`, `default: () => []`. Actualizar tabla de ownership §8.2 en el JSDoc.

### C. Config / registry
- [ ] `src/config/templateContext.config.ts`: `TEMPLATE_CONTEXT_REGISTRY` (`as const`) mapeando `template_name` → `{ description, suggestedIntentHint? }` para nombres conocidos. Fallback genérico (nombre + params crudos) para desconocidos.
- [ ] `src/config/env.ts`: `TEMPLATE_CONTEXT_ENABLED` (default `true`), `TEMPLATE_CONTEXT_WINDOW_HOURS` (default 48), `TEMPLATE_CONTEXT_LIMIT` (default 5). **+ `tests/setup.ts` + `.env.example`** (REGLAS §14.3).

### D. Pre-grafo (fetch + scope)
- [ ] `src/pregraph/pipeline.ts` paso **6.2**: si `TEMPLATE_CONTEXT_ENABLED` **y NO hay interrupt pendiente** (fresh invoke; en resume el subgrafo ya tiene contexto), fetch `getRecentTemplates({ recipientPhone: message.channelId, windowHours, limit, status:'sent' })` en `try/catch` (fail-open a `[]`, log `warn`). Filtrar por `platform_id === internalIdentity.platformId`. Pasar `recentTemplates` al `graph.invoke({...})`.

### E. Inyección en prompts
- [ ] `src/graph/nodes/renderRecentTemplates.ts`: helper puro `renderRecentTemplatesContext(templates, registry): string` (vacío → `''`). Reusable.
- [ ] `src/graph/supervisor/classifyIntent.ts`: anexar el bloque de contexto al system prompt **por turno** (desde `state.recentTemplates`). Ajustar prompt para que "sí/no/ok/dale" en respuesta a un template de confirmación/recordatorio se clasifique como `action` + intent correcto.
- [ ] `src/graph/supervisor/socialResponder.ts`: incluir el mismo bloque en el system prompt para responder con conciencia del último template.

### F. Tests (Vitest, `tests/unit/`)
- [ ] `GuacucoClient.getRecentTemplates` (mapeo + unwrap + error tipado).
- [ ] `renderRecentTemplatesContext` (registry hit, fallback, vacío).
- [ ] pipeline paso 6.2 (fetch solo en fresh invoke, filtro platform_id, fail-open a `[]` si Guacuco falla).
- [ ] `classifyIntent` con contexto de template → "sí" rutea a `action:confirm`.

### G. Verificación
- [ ] `pnpm typecheck` + `pnpm test` + `pnpm lint`.
- [ ] `--c`: SELECT a `template_send_log` para validar columnas reales (`metadata->>'platform_id'`, `parameters`, `channel_phone_number_id`) y que el shape del mapper coincide.

## Auditoría post-implementación
REGLAS_ISLADEPLATA (§2 deps, §6 BaseHttpClient, §8.2 ownership, §11 LLM config, §13 seguridad/logging maskPhone, §14.3 env) + REGLAS_GUACUCO (solo compliance del endpoint consumido).

## Review

**Estado**: completo. Backend ya existía (consumo del endpoint `/template-send-log/recent`); todo el trabajo fue IDP.

**Archivos nuevos**:
- `src/core/types/RecentTemplate.ts` — tipo puro + `EMPTY_RECENT_TEMPLATES`.
- `src/clients/mappers/RecentTemplateMapper.ts` — raw snake_case → camelCase + extracción de `platformId`.
- `src/config/templateContext.config.ts` — registry por-prefijo (basado en nombres reales del log) + `lookupTemplateContext`.
- `src/graph/nodes/renderRecentTemplates.ts` — helper puro de render del bloque de contexto.

**Archivos modificados**:
- `src/clients/types/GuacucoTypes.ts` — `GetRecentTemplatesInput`, `RecentTemplateRaw`, `RecentTemplatesRawResponse`.
- `src/clients/GuacucoClient.ts` — método `getRecentTemplates()`.
- `src/graph/state.ts` — canal `recentTemplates` (replace-only) + fila en tabla ownership §8.2.
- `src/config/env.ts` + `tests/setup.ts` + `.env.example` — `TEMPLATE_CONTEXT_{ENABLED,WINDOW_HOURS,LIMIT}`.
- `src/pregraph/pipeline.ts` — paso 7.2 `fetchRecentTemplates` (solo fresh invoke, fail-open, filtro por platformId) + pasaje a `graph.invoke`.
- `src/graph/supervisor/classifyIntent.ts` + `socialResponder.ts` — inyección del bloque al system prompt.

**Tests** (+19, total 833 ✓): GuacucoClient.getRecentTemplates (4), renderRecentTemplates (7), classifyIntent (2), socialResponder (1), pipeline recent-template (5).

**Verificación**: `pnpm typecheck` ✓ · `pnpm lint` ✓ · `pnpm test` 833 ✓ · DB `--c` columnas + nombres reales validados.

**Nota de diseño (no-bloqueante)**: en turno de resume (Command), el checkpoint retiene los `recentTemplates` del último fresh invoke (no se re-fetchea). Es inocuo: son los mismos templates del usuario dentro de la ventana, y el próximo fresh invoke los sobreescribe (replace-only).
