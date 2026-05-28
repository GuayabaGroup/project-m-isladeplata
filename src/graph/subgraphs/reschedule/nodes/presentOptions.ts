import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Presenta los proposed_slots cuando validate retornó passed=false. Determinístico
 * — IDs `slot_pick:N`. Pick → copia date+time a slots y marca exactMatch=true
 * (la opción vino de Guacuco, no re-validamos). Texto libre → re-parse del nuevo
 * date/time, vuelve a collecting para re-validate.
 *
 * Sin proposed_slots → handed_off.
 */

export interface ReschedulePresentOptionsDeps {
  logger: Logger;
}

const LIST_ROW_CAP = 10;

const NO_OPTIONS_OUTCOME: Outcome = {
  action: 'handed_off',
  pendingReply: {
    text: 'No tengo horarios disponibles para esa búsqueda. Un humano del equipo te va a contactar.',
  },
};

export function makeReschedulePresentOptionsNode(deps: ReschedulePresentOptionsDeps) {
  const { logger } = deps;

  return function presentOptions(state: {
    identity?: Identity | null;
    subgraphState?: unknown;
  }): Partial<RescheduleDraftState> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) return {};
    const proposed = current.availability.proposedSlots;

    if (proposed.length === 0) {
      logger.warn('reschedule.presentOptions: no proposedSlots, handing off');
      return { phase: 'failed', terminalOutcome: NO_OPTIONS_OUTCOME };
    }

    const slice = proposed.slice(0, LIST_ROW_CAP);
    const rows = slice.map((p, i) => ({
      id: `slot_pick:${i}`,
      title: p.label.slice(0, 24),
    }));

    const payload: NonNullable<Outcome['pendingReply']> = {
      list: {
        body: 'Ese horario no está disponible para reagendar. Te propongo estas opciones (tap para elegir, o escribime otra fecha/hora):',
        buttonLabel: 'Ver opciones',
        rows,
      },
    };

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('reschedule.presentOptions resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return processReply(reply, slice, current, state.identity);
  };
}

function processReply(
  reply: ResumePayload | undefined,
  shown: RescheduleDraftState['availability']['proposedSlots'],
  current: RescheduleDraftState,
  identity: Identity | null | undefined,
): Partial<RescheduleDraftState> {
  const safe = reply ?? { text: '' };
  const buttonId = safe.buttonId;

  if (buttonId?.startsWith('slot_pick:')) {
    const idx = Number.parseInt(buttonId.slice('slot_pick:'.length), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < shown.length) {
      const pick = shown[idx];
      if (pick) {
        return {
          slots: {
            ...current.slots,
            newDate: { value: pick.date, status: 'resolved' },
            newTime: { value: pick.time, status: 'resolved' },
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

  // Texto libre → re-propuesta del usuario. Re-parsea, limpia availability, vuelve a collecting.
  const text = sanitizeUserInput(safe.text);
  if (text.length > 0) {
    const timezone = identity?.timezone ?? 'UTC';
    const parsed = parseUserSlotReply(text, timezone);
    const updatedSlots = { ...current.slots };
    if (parsed.date) {
      updatedSlots.newDate = { value: parsed.date, userPhrase: text, status: 'resolved' };
    } else {
      updatedSlots.newDate = { userPhrase: text, status: 'guessed' };
    }
    if (parsed.time) {
      updatedSlots.newTime = { value: parsed.time, userPhrase: text, status: 'resolved' };
    }
    return {
      slots: updatedSlots,
      availability: { proposedSlots: [] },
      phase: 'collecting',
    };
  }

  return { phase: 'awaiting_pick' };
}
