# Tareas — Corrección A1, A2, A3 (Isladeplata)

> Fixes derivados del análisis de brechas 2026-05-28. Objetivo: que cancel/confirm/reschedule
> funcionen end-to-end y que el usuario pueda cambiar de intent mid-flow.

---

## A1 — Poblar `crmContext.upcomingAppointments` desde Guacuco identity `[CRÍTICO, bajo riesgo]`

Hoy `pipeline.ts:212` deja el CRM vacío cuando `PARGUITO_ENABLED=false` (default actual),
así que cancel/confirm/reschedule siempre ven 0 turnos. REGLAS §7.1 paso 7 exige augmentar
con `profileData.appointments` de Guacuco (que ya viene en identity resolve).

- [ ] `core/types/CrmContext.ts`: `startAt` → opcional (`startAt?: string`). Guacuco
      `profile_data.appointments` solo trae `{appointment_uuid, description}` (sin fecha).
- [ ] `pregraph/pipeline.ts`: nuevo helper `crmContextFromIdentity(base, identity)` que mapea
      `identity.profileData.appointments` → `upcomingAppointments` (Guacuco es la fuente de
      verdad de turnos). `profileMeta` se mantiene de Parguito (o `{}`).
- [ ] Wire en step 6: `const crmBase = PARGUITO_ENABLED ? await parguito... : EMPTY_CRM_CONTEXT;`
      `const crmContext = crmContextFromIdentity(crmBase, identity);`
- [ ] Verificar que ningún consumidor asuma `startAt` presente (askSlot ya usa `u.startAt ?`).
- [ ] Tests: unit del helper + pipeline (identity con appointments → crmContext poblado).

## A3 — Resolución texto libre → appointmentUuid en cancel/confirm/reschedule `[ALTO, bajo riesgo]`

Hoy solo `schedule` tiene `resolveEntities`. En los otros 3, texto libre queda `status:'guessed'`
y nunca se resuelve → loop hasta `handed_off` salvo que el usuario tappee el botón de la lista.

- [ ] Helper puro compartido `graph/subgraphs/common/matchAppointment.ts`:
      `matchAppointmentByPhrase(phrase, candidates): UpcomingAppointment | null` (normalize +
      exact/substring sobre `description`; null si 0 o múltiples ambiguos). Mismo patrón que
      `findServiceByName` en schedule/resolveEntities.
- [ ] `cancel/nodes/askSlot.ts` interpretReply: rama texto libre → intentar match; si único →
      `status:'resolved'` + `phase:'awaiting_confirmation'`; si no → `guessed` (como hoy).
- [ ] `confirm/nodes/askSlot.ts` interpretReply: igual → si match `phase:'committing'`.
- [ ] `reschedule/nodes/askSlot.ts` interpretReply (rama `appointmentUuid`): igual → resolved.
- [ ] Tests: match único, 0 match, múltiples ambiguos, accent-insensitive, por subgrafo.

## A2 — Abdicación de intent mid-flow (supervisor §10.2) `[ALTO, riesgo medio — TIER-1]`

El `Command(resume)` salta al nodo interrumpido; el supervisor no corre en resume. La
abdicación se implementa como **gate pre-grafo** antes de decidir resume vs fresh.

- [ ] `pregraph/AbdicationDetector.ts`: `detect(text, activeSubgraph): Promise<{abdicate, newIntent?}>`.
      LLM Haiku (SUPERVISOR_CONFIG) con prompt enfocado ("el usuario está en medio de {flow};
      ¿este mensaje responde a la pregunta o es un pedido nuevo?"). **Fail-closed**: parse fail o
      baja confianza → `abdicate:false` (reanuda — default seguro, no se pierde el draft por error).
      Solo se invoca con texto libre (los button payloads SIEMPRE reanudan, nunca abdican).
- [ ] `infrastructure/checkpointer/PostgresCheckpointerService.ts`: `deleteThread(threadId)`
      (reusa el DELETE del cleanup para un solo thread). Expuesto vía `ThreadResolver.discardThread`.
- [ ] `pregraph/pipeline.ts` step 7.1: si `pendingInterrupts && !buttonPayload`:
      - `detect()`. Si `abdicate` → `discardThread(threadId)` + invoke FRESH (supervisor reclasifica
        y rutea al subgrafo nuevo). Si no → `Command(resume)` como hoy.
      - Métrica `subgraph_abdicated_total{from,to}` (nueva en metrics.ts).
- [ ] `main/bootstrap.ts`: wire `AbdicationDetector` (recibe `llm`) en deps del pipeline.
- [ ] `config/env.ts` + `tests/setup.ts` + `.env`: (si hace falta threshold/flag) — evaluar.
- [ ] Tests: detector (abdica / reanuda / fail-closed); pipeline (texto nuevo intent → fresh;
      button → resume; ambiguo → resume).

### Decisión de producto pendiente (A2)
Al abdicar: ¿se **descarta** el draft en curso (UX simple, el usuario claramente cambió de tema)
o se **preserva** para ofrecer retomarlo después? Default propuesto: descartar.

---

## Orden de ejecución
1. A1 (desbloquea los 3 subgrafos) → typecheck + test
2. A3 (resolución texto libre) → typecheck + test
3. A2 (abdicación, TIER-1) → typecheck + test
4. Auditoría post-implementación contra REGLAS_ISLADEPLATA.md

## Review
_(a completar al cerrar)_
