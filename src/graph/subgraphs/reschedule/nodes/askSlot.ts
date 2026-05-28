import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { RescheduleDraftSlots, RescheduleDraftState } from '../state.js';

/**
 * AskSlot del reschedule. 3 slots posibles:
 *  - appointmentUuid → list con upcomings (apt_pick:uuid). Bootstrap pre-fillea
 *    si hay un solo upcoming, así que en práctica este pedido sólo ocurre
 *    cuando hay 2+.
 *  - newDate, newTime → texto libre con parseUserSlotReply (acepta los dos
 *    en un solo mensaje "mañana a las 16").
 *
 * Guard anti-loop MAX_ATTEMPTS=5 igual a los otros subgrafos.
 */

export interface RescheduleAskSlotDeps {
  logger: Logger;
}

export const RESCHEDULE_MAX_ATTEMPTS = 5;
const LIST_ROW_CAP = 10;

const HANDOFF_TEXT = 'No pude completar el reagendamiento. Un humano del equipo te va a contactar.';

type MissingSlot = 'appointmentUuid' | 'newDateTime';

function nextMissing(slots: RescheduleDraftSlots): MissingSlot | null {
  if (slots.appointmentUuid.status !== 'resolved' || !slots.appointmentUuid.value) {
    return 'appointmentUuid';
  }
  const dateResolved = slots.newDate.status === 'resolved' && !!slots.newDate.value;
  const timeResolved = slots.newTime.status === 'resolved' && !!slots.newTime.value;
  if (!dateResolved || !timeResolved) return 'newDateTime';
  return null;
}

export function makeRescheduleAskSlotNode(deps: RescheduleAskSlotDeps) {
  const { logger } = deps;

  return function askSlot(state: {
    crmContext?: CrmContext;
    identity?: Identity | null;
    subgraphState?: unknown;
  }): Partial<RescheduleDraftState> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) {
      logger.warn('reschedule.askSlot: no subgraphState');
      return { phase: 'failed' };
    }

    if (current.meta.attempts >= RESCHEDULE_MAX_ATTEMPTS) {
      const terminalOutcome: Outcome = {
        action: 'handed_off',
        pendingReply: { text: HANDOFF_TEXT },
      };
      return { phase: 'failed', terminalOutcome };
    }

    const missing = nextMissing(current.slots);
    if (missing === null) {
      // Todos los slots resueltos → router debería haber ido a validate.
      return { phase: 'validating_availability' };
    }

    const upcomings = (state.crmContext?.upcomingAppointments ?? []).slice(0, LIST_ROW_CAP);
    const payload = buildPayload(missing, upcomings);

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('reschedule.askSlot resumed', {
      missing,
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return interpretReply(missing, reply, upcomings, current.slots, state.identity);
  };
}

function buildPayload(
  missing: MissingSlot,
  upcomings: UpcomingAppointment[],
): NonNullable<Outcome['pendingReply']> {
  if (missing === 'appointmentUuid') {
    if (upcomings.length > 0) {
      return {
        list: {
          body: '¿Cuál de tus turnos querés reagendar?',
          buttonLabel: 'Ver turnos',
          rows: upcomings.map((u) => ({
            id: `apt_pick:${u.appointmentUuid}`,
            title: u.description.slice(0, 24),
            ...(u.startAt ? { description: u.startAt.slice(0, 60) } : {}),
          })),
        },
      };
    }
    return { text: '¿Cuál turno querés reagendar? Decime fecha y servicio.' };
  }
  // newDateTime
  return {
    text: '¿Para cuándo lo querés mover? Decime día y hora (ej: "mañana a las 16" o "jueves 10hs").',
  };
}

function interpretReply(
  missing: MissingSlot,
  reply: ResumePayload | undefined,
  upcomings: UpcomingAppointment[],
  currentSlots: RescheduleDraftSlots,
  identity: Identity | null | undefined,
): Partial<RescheduleDraftState> {
  const safe = reply ?? { text: '' };

  if (missing === 'appointmentUuid') {
    const buttonId = safe.buttonId;
    if (buttonId?.startsWith('apt_pick:')) {
      const uuid = buttonId.slice('apt_pick:'.length);
      const match = upcomings.find((u) => u.appointmentUuid === uuid);
      if (match) {
        return {
          slots: {
            ...currentSlots,
            appointmentUuid: {
              value: match.appointmentUuid,
              displayName: match.description,
              status: 'resolved',
            },
            // Limpieza defensiva — si llegamos acá con date/time del fallido attempt anterior, reseteamos.
            newDate: { status: 'empty' },
            newTime: { status: 'empty' },
          },
          phase: 'collecting',
          meta: { attempts: 1, recoverableErrors: [] },
        };
      }
    }
    const text = sanitizeUserInput(safe.text);
    if (text.length > 0) {
      return {
        slots: {
          ...currentSlots,
          appointmentUuid: { userPhrase: text, status: 'guessed' },
        },
        meta: { attempts: 1, recoverableErrors: [] },
      };
    }
    return { meta: { attempts: 1, recoverableErrors: [] } };
  }

  // newDateTime
  const text = sanitizeUserInput(safe.text);
  if (text.length === 0) {
    return { meta: { attempts: 1, recoverableErrors: [] } };
  }
  const timezone = identity?.timezone ?? 'UTC';
  const parsed = parseUserSlotReply(text, timezone);

  const updated: RescheduleDraftSlots = { ...currentSlots };
  if (parsed.date) {
    updated.newDate = { value: parsed.date, userPhrase: text, status: 'resolved' };
  } else {
    updated.newDate = { userPhrase: text, status: 'guessed' };
  }
  if (parsed.time) {
    updated.newTime = { value: parsed.time, userPhrase: text, status: 'resolved' };
  } else if (!parsed.date) {
    updated.newTime = { userPhrase: text, status: 'guessed' };
  }
  return {
    slots: updated,
    phase: 'collecting',
    meta: { attempts: 1, recoverableErrors: [] },
  };
}
