import { interrupt } from '@langchain/langgraph';
import type { Logger } from 'winston';
import { type CatalogState, flattenStaff } from '../../../../core/types/Catalog.js';
import type { Identity } from '../../../../core/types/Identity.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import { sanitizeUserInput } from '../../../../security/sanitize.js';
import { parseUserSlotReply } from '../../../nodes/parseUserSlotReply.js';
import type { AppointmentDraftSlots, AppointmentDraftState, SlotState } from '../state.js';
import { type MissingSlot, checkCompleteness } from './checkCompleteness.js';

/**
 * Nodo de slot-filling. Hace una iteración del loop "qué falta → preguntar →
 * recibir reply → aplicar al state". Idempotente en pre-interrupt (templates
 * de pregunta determinísticas, no LLM).
 *
 * Mecánica LangGraph:
 *   - Primera ejecución: `interrupt(payload)` LANZA → graph se pausa,
 *     state pre-ejecución persiste. El parent dispatch envía `payload` al
 *     usuario.
 *   - Resume con `Command(resume=ResumePayload)`: el nodo re-corre con el
 *     mismo state. `interrupt(...)` ahora RETORNA `ResumePayload`. El nodo
 *     procesa el reply y retorna el state update — meta.attempts++ ocurre
 *     sólo en este return.
 *
 * Guard anti-loop: si `meta.attempts >= MAX_ATTEMPTS` retorna handed_off
 * sin pedir (rompe el ciclo).
 */

export interface AskSlotDeps {
  logger: Logger;
}

/** Payload que el parent graph entrega vía `Command(resume=...)`. */
export interface ResumePayload {
  /** Texto sanitizado del usuario (vacío si tapeó botón). */
  text: string;
  /** ID del button / list item si el reply fue interactivo. */
  buttonId?: string;
}

export const MAX_ATTEMPTS = 5;

const HANDOFF_TEXT =
  'No pude completar el agendamiento. Un humano del equipo te va a contactar a la brevedad.';

export function makeAskSlotNode(deps: AskSlotDeps) {
  const { logger } = deps;

  return function askSlot(state: {
    catalog?: CatalogState;
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Partial<AppointmentDraftState> {
    const current = state.subgraphState;
    if (!current) {
      logger.warn('askSlot called without subgraphState');
      return { phase: 'failed' };
    }

    const profileType = state.identity?.profileType ?? 'client';
    const catalog = state.catalog ?? { services: [] };

    const missing = checkCompleteness(current.slots, profileType);
    if (missing === null) {
      // No debería pasar (el router decide antes), pero handle gracefully.
      logger.debug('askSlot: nothing missing, routing to validate');
      return { phase: 'validating_availability' };
    }

    // Guard anti-loop ANTES de pedir.
    if (current.meta.attempts >= MAX_ATTEMPTS) {
      logger.warn('askSlot: max attempts reached, handing off', {
        attempts: current.meta.attempts,
        missing,
      });
      const terminalOutcome: Outcome = {
        action: 'handed_off',
        pendingReply: { text: HANDOFF_TEXT },
      };
      return { phase: 'failed', terminalOutcome };
    }

    const payload = buildSlotPayload(missing, current.slots, catalog);

    // PRIMER PASS: interrupt LANZA. SEGUNDO PASS (resume): retorna ResumePayload.
    const reply = interrupt({ pendingReply: payload }) as ResumePayload;

    logger.debug('askSlot resumed', {
      missing,
      hasButton: !!reply?.buttonId,
      textLen: reply?.text?.length ?? 0,
    });

    const slotsUpdate = interpretReply(missing, reply, catalog, state.identity);

    return {
      slots: { ...current.slots, ...slotsUpdate },
      phase: 'resolving_entities',
      meta: { attempts: 1, recoverableErrors: [] },
    };
  };
}

// ============================================================================
// Build interactive payload (templates determinísticos)
// ============================================================================

function buildSlotPayload(
  missing: MissingSlot,
  slots: AppointmentDraftSlots,
  catalog: CatalogState,
): NonNullable<Outcome['pendingReply']> {
  switch (missing) {
    case 'services':
      return buildServicesPayload(catalog);
    case 'staff':
      return buildStaffPayload(slots, catalog);
    case 'date_time':
      return { text: '¿Para cuándo? Decime día y hora (ej: "mañana a las 16" o "lunes 10hs").' };
    case 'clientUuid':
      return { text: '¿Para qué cliente? Decime nombre o teléfono.' };
  }
}

const LIST_ROW_CAP = 10;

function buildServicesPayload(catalog: CatalogState): NonNullable<Outcome['pendingReply']> {
  if (catalog.services.length === 0) {
    return { text: '¿Qué servicio querés? (No tengo el catálogo a mano, decime el nombre)' };
  }
  const rows = catalog.services.slice(0, LIST_ROW_CAP).map((s) => ({
    id: `service:${s.uuid}`,
    title: s.name.slice(0, 24),
    ...(s.price ? { description: formatPrice(s.price) } : {}),
  }));
  return {
    list: {
      body: '¿Qué servicio querés agendar?',
      buttonLabel: 'Ver servicios',
      rows,
    },
  };
}

function buildStaffPayload(
  slots: AppointmentDraftSlots,
  catalog: CatalogState,
): NonNullable<Outcome['pendingReply']> {
  // Filtrar staff por los servicios ya elegidos (intersección si multi-service).
  let candidates = flattenStaff(catalog);
  if (slots.services.status === 'resolved' && Array.isArray(slots.services.value)) {
    const serviceUuids = new Set(slots.services.value);
    const matchedServices = catalog.services.filter((s) => serviceUuids.has(s.uuid));
    if (matchedServices.length > 0) {
      const staffSets = matchedServices.map((s) => new Set(s.staff.map((st) => st.uuid)));
      candidates = candidates.filter((st) => staffSets.every((set) => set.has(st.uuid)));
    }
  }

  if (candidates.length === 0) {
    return { text: '¿Con quién te gustaría atenderte? Decime el nombre.' };
  }

  const rows = candidates.slice(0, LIST_ROW_CAP).map((s) => ({
    id: `staff:${s.uuid}`,
    title: s.name.slice(0, 24),
  }));
  return {
    list: {
      body: '¿Con quién querés atenderte?',
      buttonLabel: 'Ver personas',
      rows,
    },
  };
}

function formatPrice(price: number): string {
  return `$${price.toLocaleString('es-AR')}`;
}

// ============================================================================
// Interpret resume reply
// ============================================================================

function interpretReply(
  missing: MissingSlot,
  reply: ResumePayload | undefined,
  catalog: CatalogState,
  identity: Identity | null | undefined,
): Partial<AppointmentDraftSlots> {
  const safeReply: ResumePayload = reply ?? { text: '' };
  const text = sanitizeUserInput(safeReply.text);
  const buttonId = safeReply.buttonId;

  switch (missing) {
    case 'services':
      return interpretServicesReply(text, buttonId, catalog);
    case 'staff':
      return interpretStaffReply(text, buttonId, catalog);
    case 'date_time':
      return interpretDateTimeReply(text, identity);
    case 'clientUuid':
      return interpretClientUuidReply(text);
  }
}

function interpretServicesReply(
  text: string,
  buttonId: string | undefined,
  catalog: CatalogState,
): Partial<AppointmentDraftSlots> {
  if (buttonId?.startsWith('service:')) {
    const uuid = buttonId.slice('service:'.length);
    const match = catalog.services.find((s) => s.uuid === uuid);
    if (match) {
      const slot: SlotState<string[]> = {
        value: [match.uuid],
        displayName: match.name,
        status: 'resolved',
      };
      return { services: slot };
    }
  }
  // Free text → push as userPhrase, let resolveEntities run on next pass.
  if (text.length > 0) {
    const slot: SlotState<string[]> = { userPhrase: text, status: 'guessed' };
    return { services: slot };
  }
  return {};
}

function interpretStaffReply(
  text: string,
  buttonId: string | undefined,
  catalog: CatalogState,
): Partial<AppointmentDraftSlots> {
  if (buttonId?.startsWith('staff:')) {
    const uuid = buttonId.slice('staff:'.length);
    const allStaff = flattenStaff(catalog);
    const match = allStaff.find((s) => s.uuid === uuid);
    if (match) {
      const slot: SlotState<string> = {
        value: match.uuid,
        displayName: match.name,
        status: 'resolved',
      };
      return { staff: slot };
    }
  }
  if (text.length > 0) {
    const slot: SlotState<string> = { userPhrase: text, status: 'guessed' };
    return { staff: slot };
  }
  return {};
}

function interpretDateTimeReply(
  text: string,
  identity: Identity | null | undefined,
): Partial<AppointmentDraftSlots> {
  if (text.length === 0) return {};
  const timezone = identity?.timezone ?? 'UTC';
  const parsed = parseUserSlotReply(text, timezone);

  const update: Partial<AppointmentDraftSlots> = {};
  if (parsed.date) {
    update.date = { value: parsed.date, userPhrase: text, status: 'resolved' };
  } else {
    update.date = { userPhrase: text, status: 'guessed' };
  }
  if (parsed.time) {
    update.time = { value: parsed.time, userPhrase: text, status: 'resolved' };
  } else if (!parsed.date) {
    // Si no parseamos nada, ambos quedan en guessed.
    update.time = { userPhrase: text, status: 'guessed' };
  }
  return update;
}

function interpretClientUuidReply(text: string): Partial<AppointmentDraftSlots> {
  if (text.length === 0) return {};
  // v1 scope: sin búsqueda CRM. Guardamos texto libre como userPhrase.
  // El operador staff luego corrige desde dashboard o el subgrafo handed_off.
  // Si Guacuco/Parguito eventualmente exponen búsqueda, esto se reemplaza.
  return {
    clientUuid: { userPhrase: text, status: 'guessed' },
  };
}
