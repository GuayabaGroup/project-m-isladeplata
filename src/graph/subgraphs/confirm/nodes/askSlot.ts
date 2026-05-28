import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import type { CrmContext, UpcomingAppointment } from '../../../../core/types/CrmContext.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import type { ResumePayload } from '../../schedule/nodes/askSlot.js';
import type { ConfirmDraftState } from '../state.js';

/**
 * AskSlot del confirm: lista los upcomings como WhatsApp list con IDs
 * `apt_pick:<uuid>`. Determinístico (sin LLM, idempotente en re-run).
 *
 * Post-resume:
 * - button `apt_pick:<uuid>` matchea uno de los upcomings mostrados → resolve slot, phase='committing'.
 * - texto libre → status='guessed' con userPhrase (no resolvemos texto a UUID en v1).
 *   El siguiente pass de bootstrap+check no avanzará → ask_slot loop hasta MAX_ATTEMPTS.
 *
 * Guard anti-loop: `meta.attempts >= MAX_ATTEMPTS` → handed_off.
 */

export interface ConfirmAskSlotDeps {
  logger: Logger;
}

export const CONFIRM_MAX_ATTEMPTS = 5;
const LIST_ROW_CAP = 10;

const HANDOFF_TEXT =
  'No pude identificar el turno a confirmar. Un humano del equipo te va a contactar.';

export function makeConfirmAskSlotNode(deps: ConfirmAskSlotDeps) {
  const { logger } = deps;

  return function askSlot(state: {
    crmContext?: CrmContext;
    subgraphState?: unknown;
  }): Partial<ConfirmDraftState> {
    const current = state.subgraphState as ConfirmDraftState | undefined;
    if (!current) return { phase: 'failed' };

    if (current.meta.attempts >= CONFIRM_MAX_ATTEMPTS) {
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
              body: '¿Cuál de tus turnos querés confirmar?',
              buttonLabel: 'Ver turnos',
              rows: upcomings.map((u) => ({
                id: `apt_pick:${u.appointmentUuid}`,
                title: u.description.slice(0, 24),
                ...(u.startAt ? { description: u.startAt.slice(0, 60) } : {}),
              })),
            },
          }
        : { text: '¿Cuál turno querés confirmar? Decime fecha y servicio.' };

    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('confirm.askSlot resumed', {
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    return interpretReply(reply, upcomings);
  };
}

function interpretReply(
  reply: ResumePayload | undefined,
  shown: UpcomingAppointment[],
): Partial<ConfirmDraftState> {
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
        phase: 'committing',
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
      // phase queda 'collecting'
    };
  }

  return { meta: { attempts: 1, recoverableErrors: [] } };
}
