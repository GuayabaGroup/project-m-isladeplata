import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { AppointmentDraftState } from '../state.js';
import type { ResumePayload } from './askSlot.js';

/**
 * Gate de confirmación. Construye interactive payload con buttons
 * `confirm:<intentUuid>` / `cancel:<intentUuid>` + interrupt.
 *
 * Pre-requisito: `confirmation.intentUuid` + `confirmation.message` ya
 * seteados por `build_confirm_message` (corre antes).
 *
 * Post-resume:
 * - Button confirm con intentUuid matching → `phase='committing'` → commit
 * - Button cancel con intentUuid matching → cancel_handler inline → 'collecting'
 * - Otro buttonId o texto libre → cancel implícito (limpia confirmation,
 *   re-parsea texto si vino con nueva fecha/hora, vuelve a collecting)
 *
 * Stale uuids (button viejo de gate previo) caen al cancel implícito.
 * Esto es deliberado: §5.1 PLAN_H4 — el intentUuid existe justamente para
 * que un tap stale NO confirme.
 */

export interface GateConfirmDeps {
  logger: Logger;
}

const NO_GATE_OUTCOME: Outcome = {
  action: 'error',
  pendingReply: {
    text: 'Tuve un problema preparando la confirmación. Probá de nuevo en un minuto.',
  },
};

export function makeGateConfirmNode(deps: GateConfirmDeps) {
  const { logger } = deps;

  return function gateConfirm(state: {
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Partial<AppointmentDraftState> {
    const current = state.subgraphState;
    if (!current) {
      logger.warn('gateConfirm: no subgraphState');
      return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }
    const { intentUuid, message } = current.confirmation;
    if (!intentUuid || !message) {
      logger.warn('gateConfirm: missing intentUuid or message', {
        hasUuid: !!intentUuid,
        hasMessage: !!message,
      });
      return { phase: 'failed', terminalOutcome: NO_GATE_OUTCOME };
    }

    const payload: NonNullable<Outcome['pendingReply']> = {
      text: message,
      buttons: [
        { id: `confirm:${intentUuid}`, title: 'Confirmar' },
        { id: `cancel:${intentUuid}`, title: 'Cancelar' },
      ],
    };

    // PRIMER PASS: interrupt LANZA. SEGUNDO PASS: retorna ResumePayload.
    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('gateConfirm resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return processReply(reply, current, state.identity);
  };
}

function processReply(
  reply: ResumePayload | undefined,
  current: AppointmentDraftState,
  identity: Identity | null | undefined,
): Partial<AppointmentDraftState> {
  const safe = reply ?? { text: '' };
  const buttonId = safe.buttonId;
  const intentUuid = current.confirmation.intentUuid;

  if (buttonId && intentUuid) {
    if (buttonId === `confirm:${intentUuid}`) {
      return { phase: 'committing' };
    }
    if (buttonId === `cancel:${intentUuid}`) {
      return cancelHandler(current);
    }
  }

  // Stale uuid, button distinto, o texto libre → cancel implícito.
  // Si vino con texto y parseable como nueva fecha/hora, re-pisamos slots.
  return cancelImplicit(safe.text, current, identity);
}

/**
 * Cancel explícito (botón Cancelar). Limpia confirmation + availability cache,
 * preserva slots, vuelve a collecting.
 */
function cancelHandler(current: AppointmentDraftState): Partial<AppointmentDraftState> {
  return {
    confirmation: {},
    availability: {
      lastCheckedFor: current.availability.lastCheckedFor,
      proposedSlots: [],
    },
    phase: 'collecting',
  };
}

/**
 * Cancel implícito: usuario manda texto libre o botón stale durante el gate.
 * Si parsea fecha/hora, pisa esos slots para forzar re-validate en próximo pass.
 * Slots no relacionados (services, staff) se preservan.
 */
function cancelImplicit(
  text: string,
  current: AppointmentDraftState,
  identity: Identity | null | undefined,
): Partial<AppointmentDraftState> {
  const clean = sanitizeUserInput(text);
  const baseUpdate = cancelHandler(current);

  if (clean.length === 0) return baseUpdate;

  const timezone = identity?.timezone ?? 'UTC';
  const parsed = parseUserSlotReply(clean, timezone);
  if (!parsed.date && !parsed.time) return baseUpdate;

  const updatedSlots = { ...current.slots };
  if (parsed.date) {
    updatedSlots.date = { value: parsed.date, userPhrase: clean, status: 'resolved' };
  }
  if (parsed.time) {
    updatedSlots.time = { value: parsed.time, userPhrase: clean, status: 'resolved' };
  }

  return { ...baseUpdate, slots: updatedSlots };
}
