import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Outcome } from '../../../core/types/Outcome.js';
import type { ResumePayload } from '../schedule/nodes/askSlot.js';

/**
 * Mecánica compartida del gate de confirmación (TIER 1, §15.7) entre los
 * subgrafos `cancel` y `reschedule` (schedule tiene su propia variante con
 * re-parse de fecha). Centraliza el `interrupt()` + el matching de `intentUuid`
 * que ambos duplicaban byte-por-byte.
 *
 * Devuelve una DECISIÓN — cada nodo la mapea a su `Partial<TDraft>` con sus
 * literales de `phase` concretos, así el helper queda type-safe sin casts y
 * cada subgrafo conserva su texto de error y título de botón.
 */
export type GateDecision = 'commit' | 'reset_gate' | 'no_gate';

export interface GateConfirmConfig {
  logger: Logger;
  /** Título del botón de confirmación (ej. "Sí, cancelar"). */
  confirmTitle: string;
  /** Prefijo para logs (ej. "cancel", "reschedule"). */
  logLabel: string;
}

interface GateableDraft {
  confirmation: { intentUuid?: string; message?: string };
}

/**
 * Corre el gate: valida la confirmación preparada, lanza el `interrupt()` con
 * los botones `confirm:<uuid>` / `cancel:<uuid>` y clasifica la respuesta.
 *
 * - confirmación ausente/incompleta → `'no_gate'`
 * - tap en `confirm:<uuid>` → `'commit'`
 * - tap en `cancel:<uuid>`, uuid stale o texto libre → `'reset_gate'`
 */
export function runGateConfirm(
  config: GateConfirmConfig,
  current: GateableDraft | undefined,
): GateDecision {
  const { logger, confirmTitle, logLabel } = config;
  if (!current) return 'no_gate';

  const { intentUuid, message } = current.confirmation;
  if (!intentUuid || !message) {
    logger.warn(`${logLabel}.gateConfirm: missing intentUuid or message`);
    return 'no_gate';
  }

  const payload: NonNullable<Outcome['pendingReply']> = {
    text: message,
    buttons: [
      { id: `confirm:${intentUuid}`, title: confirmTitle },
      { id: `cancel:${intentUuid}`, title: 'No' },
    ],
  };

  const reply = interrupt({ pendingReply: payload }) as ResumePayload | undefined;

  logger.debug(`${logLabel}.gateConfirm resumed`, {
    hasButton: !!reply?.buttonId,
    textLen: reply?.text?.length ?? 0,
  });

  // intentUuid garantizado presente acá; solo el tap exacto en confirm procede.
  return reply?.buttonId === `confirm:${intentUuid}` ? 'commit' : 'reset_gate';
}
