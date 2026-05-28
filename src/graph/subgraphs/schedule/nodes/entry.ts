import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import { parseLlmJson } from '../../../../core/parseLlmJson.js';
import type { ChannelMessage } from '../../../../core/types/ChannelMessage.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { AppointmentDraftSlots, AppointmentDraftState, SlotState } from '../state.js';

/**
 * Entry del subgrafo schedule. Hace UNA llamada LLM Haiku para extraer
 * entidades del mensaje del usuario en formato JSON estructurado:
 *
 *   {services?: string, staff?: string, date?: string, time?: string, clientUuid?: string}
 *
 * Cada entidad detectada se pre-popula como `userPhrase` con `status='guessed'`.
 * Fechas/horas pasan adicionalmente por `parseUserSlotReply` (helper puro)
 * para producir `value` directo. Servicios/staff/cliente quedan en `guessed`
 * y `resolveEntities` los convierte a UUIDs.
 *
 * Decisión: la extracción de entidades vive en el subgrafo (no en el
 * classifier del supervisor). Razón: cada subgrafo extrae su propio set y
 * mantiene al supervisor magro (solo intent classification).
 */

export interface EntryDeps {
  llm: LlmProvider;
  logger: Logger;
}

interface ExtractedEntities {
  services?: string;
  staff?: string;
  date?: string;
  time?: string;
  clientUuid?: string;
}

const SYSTEM_PROMPT = `Sos un extractor de entidades de turnos. El usuario quiere agendar un turno.
Extraé las menciones explícitas (NO inventes). Devolvé SOLO JSON con shape:

{"services"?: string, "staff"?: string, "date"?: string, "time"?: string, "clientUuid"?: string}

- "services":  servicio(s) mencionados (corte, barba, masaje, manicura, etc.)
- "staff":     nombre del profesional mencionado
- "date":      día mencionado (hoy, mañana, lunes, "15 de marzo", "15/03")
- "time":      hora mencionada ("a las 4", "16:00", "por la tarde")
- "clientUuid": NUNCA inventes — solo si el usuario lo dice literal con formato UUID

Omití los campos que no aparezcan literalmente. Si nada aparece, devolvé {}.
Respondé SOLO el JSON, sin prosa ni markdown.`;

export function makeEntryNode(deps: EntryDeps) {
  const { llm, logger } = deps;

  return async function entry(state: {
    input?: { channelMessage?: ChannelMessage } | null;
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    const text = sanitizeUserInput(state.input?.channelMessage?.contentText);
    const timezone = state.identity?.timezone ?? 'UTC';

    // Si ya pasamos por entry en un turno anterior (resumen post-interrupt),
    // no re-corremos extracción. El subgrafo distingue por phase.
    if (current && current.phase !== 'resolving_entities') {
      return {};
    }

    if (text.length === 0) {
      return { phase: 'resolving_entities' };
    }

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });

    const extracted =
      parseLlmJson<ExtractedEntities>(response.text, logger, { component: 'schedule.entry' }) ?? {};

    logger.debug('schedule.entry extracted', { keys: Object.keys(extracted) });

    const slots = applyExtracted(current?.slots, extracted, timezone);
    return { slots, phase: 'resolving_entities' };
  };
}

function applyExtracted(
  current: AppointmentDraftSlots | undefined,
  extracted: ExtractedEntities,
  timezone: string,
): AppointmentDraftSlots {
  const base: AppointmentDraftSlots = current ?? {
    services: { status: 'empty' },
    staff: { status: 'empty' },
    date: { status: 'empty' },
    time: { status: 'empty' },
  };

  const next: AppointmentDraftSlots = {
    services: base.services,
    staff: base.staff,
    date: base.date,
    time: base.time,
    ...(base.clientUuid ? { clientUuid: base.clientUuid } : {}),
  };

  if (typeof extracted.services === 'string' && extracted.services.trim().length > 0) {
    next.services = mergeUserPhrase(next.services, extracted.services);
  }
  if (typeof extracted.staff === 'string' && extracted.staff.trim().length > 0) {
    next.staff = mergeUserPhrase(next.staff, extracted.staff);
  }
  if (typeof extracted.date === 'string' && extracted.date.trim().length > 0) {
    const parsed = parseUserSlotReply(extracted.date, timezone);
    next.date = parsed.date
      ? { value: parsed.date, userPhrase: extracted.date, status: 'resolved' }
      : mergeUserPhrase(next.date, extracted.date);
  }
  if (typeof extracted.time === 'string' && extracted.time.trim().length > 0) {
    const parsed = parseUserSlotReply(extracted.time, timezone);
    next.time = parsed.time
      ? { value: parsed.time, userPhrase: extracted.time, status: 'resolved' }
      : mergeUserPhrase(next.time, extracted.time);
  }
  if (
    next.clientUuid &&
    typeof extracted.clientUuid === 'string' &&
    extracted.clientUuid.trim().length > 0
  ) {
    next.clientUuid = mergeUserPhrase(next.clientUuid, extracted.clientUuid);
  }

  return next;
}

function mergeUserPhrase<T>(current: SlotState<T>, phrase: string): SlotState<T> {
  // Si el slot ya está resolved (de un turno anterior), NO sobreescribir.
  if (current.status === 'resolved') return current;
  return { ...current, userPhrase: phrase, status: 'guessed' };
}
