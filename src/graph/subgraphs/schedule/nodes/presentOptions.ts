import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { AppointmentDraftState } from '../state.js';
import type { ResumePayload } from './askSlot.js';

/**
 * Presenta las sugerencias de horario al usuario (cuando `validate_availability`
 * marcó `exactMatch=false` con suggestions). Determinístico — sin LLM:
 * el list message se construye desde `availability.proposedSlots`.
 *
 * IDs de los rows: `slot_pick:<idx>`. El supervisor (atajo button) los
 * detecta y resume el subgrafo con `Command(resume={buttonId})`.
 *
 * Post-resume:
 * - Button `slot_pick:N`: `applyProposedSlot` (otro nodo) copia date/time.
 *   Acá sólo guardamos el índice en `confirmation.message` (temporal carry).
 *   En realidad: este nodo procesa el pick acá mismo retornando el slot update.
 * - Texto libre: tratado como cancel implícito / re-propuesta del usuario.
 *   Re-parsea fecha/hora y pisa los slots → re-validate en próximo pass.
 */

export interface PresentOptionsDeps {
  logger: Logger;
}

const LIST_ROW_CAP = 10;

const NO_OPTIONS_OUTCOME: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No tengo horarios disponibles para esa búsqueda en este momento. Probá con otro día o un humano del equipo te va a contactar.',
  },
};

export function makePresentOptionsNode(deps: PresentOptionsDeps) {
  const { logger } = deps;

  return function presentOptions(state: {
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Partial<AppointmentDraftState> {
    const current = state.subgraphState;
    if (!current) return {};
    const proposed = current.availability.proposedSlots;

    // Sin sugerencias y sin exact match → handed_off (no podemos ayudar)
    if (proposed.length === 0) {
      logger.warn('presentOptions: no proposedSlots, handing off');
      return { phase: 'failed', terminalOutcome: NO_OPTIONS_OUTCOME };
    }

    const slice = proposed.slice(0, LIST_ROW_CAP);
    const rows = slice.map((p, i) => ({
      id: `slot_pick:${i}`,
      title: p.label.slice(0, 24),
    }));

    const payload: NonNullable<Outcome['pendingReply']> = {
      list: {
        body: 'Ese horario no está disponible. Te propongo estas opciones (tap para elegir, o escribime otra fecha/hora):',
        buttonLabel: 'Ver opciones',
        rows,
      },
    };

    // PRIMER PASS: interrupt LANZA. SEGUNDO PASS: retorna ResumePayload.
    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('presentOptions resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return processReply(reply, slice, current, state.identity);
  };
}

function processReply(
  reply: ResumePayload | undefined,
  shown: AppointmentDraftState['availability']['proposedSlots'],
  current: AppointmentDraftState,
  identity: Identity | null | undefined,
): Partial<AppointmentDraftState> {
  const safe = reply ?? { text: '' };
  const buttonId = safe.buttonId;

  if (buttonId?.startsWith('slot_pick:')) {
    const idx = Number.parseInt(buttonId.slice('slot_pick:'.length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < shown.length) {
      const pick = shown[idx];
      if (pick) {
        // Marcamos exactMatch=true: la opción vino de Guacuco, no re-validamos.
        return {
          slots: {
            ...current.slots,
            date: { value: pick.date, status: 'resolved' },
            time: { value: pick.time, status: 'resolved' },
          },
          availability: {
            lastCheckedFor: current.availability.lastCheckedFor,
            exactMatch: true,
            proposedSlots: [],
          },
          phase: 'awaiting_confirmation',
        };
      }
    }
  }

  // Texto libre → re-propuesta del usuario. Parseamos date/time del nuevo texto,
  // limpiamos availability cache (vamos a re-validar), volvemos a collecting.
  const text = sanitizeUserInput(safe.text);
  if (text.length > 0) {
    const timezone = identity?.timezone ?? 'UTC';
    const parsed = parseUserSlotReply(text, timezone);
    const updatedSlots = { ...current.slots };
    if (parsed.date) {
      updatedSlots.date = { value: parsed.date, userPhrase: text, status: 'resolved' };
    } else {
      updatedSlots.date = { userPhrase: text, status: 'guessed' };
    }
    if (parsed.time) {
      updatedSlots.time = { value: parsed.time, userPhrase: text, status: 'resolved' };
    }
    return {
      slots: updatedSlots,
      availability: { proposedSlots: [] },
      phase: 'collecting',
    };
  }

  // Reply vacío: volvemos a presentar (próximo pass re-corre este nodo).
  return { phase: 'awaiting_pick' };
}
