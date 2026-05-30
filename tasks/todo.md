# Fix: "llego tarde" del cliente se clasifica como confirm_appointment (--i)

**Flag:** `--i` (Isladeplata). Fecha: 2026-05-30. Proyecto LangSmith: isladeplata-prd.

## Síntoma (prod)
Cliente escribe "creo que lelgare 15 min tarde" → el bot responde "Turno confirmado…"
y ejecuta `confirm_appointment`. Debería reenviar el mensaje al negocio (`forward_message`).

## Causa raíz
1. **El classifier no tiene `forward_message` como intent.** `VALID_INTENTS` solo conoce
   `{schedule, reschedule, cancel, confirm, unknown}`. La única vía a `forward_message`
   es la heurística regex `detectAtomicTool`.
2. **La regex es demasiado estrecha**: `/\b(llegar tarde|estoy afuera|…)\b/i` solo matchea
   el substring exacto "llegar tarde". Falla con "llegaré tarde", "llegare un poco tarde",
   "lelgare 15 min tarde" (conjugación/typo/palabras intercaladas) → cae al classifier.
3. **El contexto de templates recientes sesga al classifier.** El template
   `p2_confirm_appointment_client` (enviado 2 min antes) inyecta "si responde afirmativo →
   CONFIRMAR; si negativo → CANCELAR". Con un mensaje informativo (ni sí ni no) y SIN opción
   `forward_message`, el LLM lo fuerza a `confirm` (conf 0.85) → subgrafo confirm → confirma.

## Fix (raíz, no band-aid)
- [x] `state.ts`: agregar `'forward_message'` al tipo `Intent`.
- [x] `classifyIntent.ts`: agregar `forward_message` a `VALID_INTENTS` + describirlo en el
      prompt con ejemplo explícito ("llego 15 min tarde" → forward_message, NO confirm).
- [x] `router.ts`: rutear `action:forward_message` → `tool_forward_message` (tool atómica,
      no subgrafo, gateado por `allowed.has`). Regex de fast-path ampliada (conjugaciones+acentos).
- [x] `templateContext.config.ts`: hint del template confirm aclara que avisos que no son
      sí/no (ej. "llego tarde") NO son confirmar/cancelar → forward_message.
- [x] Tests: router (action:forward_message → tool + regex variants), classifier (forward_message).

## Review
- Verificación: `pnpm typecheck` ✓ · `pnpm lint` (257 files) ✓ · `pnpm test` **872 ✓** (+3 nuevos).
- Auditoría REGLAS_ISLADEPLATA: §10.5 (gating por rol vía `allowed.has`, no en prompt) ✓ ·
  §9.2 (forwardMessage sigue produciendo solo texto, sin fabricar datos) ✓ · §15.2 naming ✓ ·
  §2 dependencias (todo dentro de graph/supervisor + config) ✓. Sin dead code, sin `any`.
