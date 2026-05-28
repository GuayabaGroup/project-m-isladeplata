import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { CancelDraftState } from '../state.js';

/**
 * AskSlot del cancel: misma mecánica que confirm.askSlot pero el texto del
 * body habla de "cancelar" y al resolver el slot setea phase=
 * 'awaiting_confirmation' (NO 'committing' — cancel necesita gate).
 */

export interface CancelAskSlotDeps {
  logger: Logger;
}

export const CANCEL_MAX_ATTEMPTS = 5;
const LIST_ROW_CAP = 10;

const HANDOFF_TEXT =
  'No pude identificar el turno a cancelar. Un humano del equipo te va a contactar.';

export function makeCancelAskSlotNode(deps: CancelAskSlotDeps) {
  const { logger } = deps;

  return function askSlot(state: {
    crmContext?: CrmContext;
    subgraphState?: unknown;
  }): Partial<CancelDraftState> {
    const current = state.subgraphState as CancelDraftState | undefined;
    if (!current) return { phase: 'failed' };

    if (current.meta.attempts >= CANCEL_MAX_ATTEMPTS) {
      const terminalOutcome: Outcome = {
        action: 'handed_off',
        pendingReply: { text: HANDOFF_TEXT },
      };
      return { phase: 'failed', terminalOutcome };
    }

    const upcomings = (state.crmContext?.upcomingAppointments ?? []).slice(0, LIST_ROW_CAP);

    const payload: NonNullable<Outcome['pendingReply']> =
      upcomings.length > 0
        ? {
            list: {
              body: '¿Cuál de tus turnos querés cancelar?',
              buttonLabel: 'Ver turnos',
              rows: upcomings.map((u) => ({
                id: `apt_pick:${u.appointmentUuid}`,
                title: u.description.slice(0, 24),
                ...(u.startAt ? { description: u.startAt.slice(0, 60) } : {}),
              })),
            },
          }
        : { text: '¿Cuál turno querés cancelar? Decime fecha y servicio.' };

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('cancel.askSlot resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return interpretReply(reply, upcomings);
  };
}

function interpretReply(
  reply: ResumePayload | undefined,
  shown: UpcomingAppointment[],
): Partial<CancelDraftState> {
  const safe = reply ?? { text: '' };
  const buttonId = safe.buttonId;

  if (buttonId?.startsWith('apt_pick:')) {
    const uuid = buttonId.slice('apt_pick:'.length);
    const match = shown.find((u) => u.appointmentUuid === uuid);
    if (match) {
      return {
        slots: {
          appointmentUuid: {
            value: match.appointmentUuid,
            displayName: match.description,
            status: 'resolved',
          },
        },
        phase: 'awaiting_confirmation', // → buildConfirmMessage + gate
        meta: { attempts: 1, recoverableErrors: [] },
      };
    }
  }

  const text = sanitizeUserInput(safe.text);
  if (text.length > 0) {
    return {
      slots: {
        appointmentUuid: { userPhrase: text, status: 'guessed' },
      },
      meta: { attempts: 1, recoverableErrors: [] },
    };
  }

  return { meta: { attempts: 1, recoverableErrors: [] } };
}
