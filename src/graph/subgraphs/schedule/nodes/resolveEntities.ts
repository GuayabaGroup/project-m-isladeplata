import type { Logger } from 'winston';
import type { GuacucoClient } from '../../../../clients/GuacucoClient.js';
import type { ProfileType } from '../../../../core/enums/ProfileType.js';
import {
  type CatalogService,
  type CatalogStaff,
  type CatalogState,
  flattenStaff,
} from '../../../../core/types/Catalog.js';
import type { Identity } from '../../../../core/types/Identity.js';
import { parseClientContact } from '../clientContact.js';
import type { AppointmentDraftSlots, AppointmentDraftState, SlotState } from '../state.js';

/**
 * Convierte `userPhrase` → `value` + `displayName` para services y staff
 * usando fuzzy match local sobre el catálogo. Determinístico — NO llama LLM.
 *
 * Reglas:
 * - `services`: split por "y" / "+" / "," → resuelve cada parte por nombre.
 *   Si TODAS las partes matchean → status='resolved' con `value=string[]`.
 *   Si alguna no matchea → status queda 'guessed' y `displayName` con prefix.
 * - `staff`: match único por nombre (con accent-strip + substring).
 * - **Staff inference** (decisión §11.1 PLAN_H4): si services está resuelto a
 *   un solo servicio Y ese servicio tiene un único staff, pre-popular staff
 *   slot con status='resolved' (ahorra 1 turno).
 * - `clientUuid` (rol=staff): se resuelve a un UUID real vía Guacuco
 *   (`resolve_client`, find-or-create por teléfono). Es la ÚNICA llamada a
 *   Guacuco autorizada desde resolve_entities — excepción documentada §9.1.3
 *   REGLAS: el cliente NO vive en el catálogo local (`helpersLists`), así que el
 *   fuzzy match local no aplica. Sin teléfono parseable o ante error de Guacuco,
 *   el slot queda en 'guessed' y ask_slot vuelve a pedir el número.
 */

export interface ResolveEntitiesDeps {
  guacuco: GuacucoClient;
  logger: Logger;
}

export function makeResolveEntitiesNode(deps: ResolveEntitiesDeps) {
  const { guacuco, logger } = deps;

  return async function resolveEntities(state: {
    catalog?: CatalogState;
    identity?: Identity | null;
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    if (!current) return {};
    const catalog = state.catalog ?? { services: [] };

    // Guard catálogo vacío: si el negocio no tiene servicios agendables (Guacuco
    // filtra los servicios sin staff asignado), pedir el servicio en loop no
    // lleva a nada — el fuzzy match nunca podrá resolver y el subgrafo iteraría
    // hasta MAX_ATTEMPTS → handoff a humano. Cerramos con un mensaje accionable
    // según rol.
    if (catalog.services.length === 0 && current.slots.services.status !== 'resolved') {
      const profileType = state.identity?.profileType ?? 'client';
      logger.info('resolveEntities: catálogo vacío, no hay servicios agendables', { profileType });
      return {
        phase: 'failed',
        terminalOutcome: {
          action: 'response',
          pendingReply: { text: emptyCatalogReply(profileType) },
        },
      };
    }

    const slots: AppointmentDraftSlots = { ...current.slots };

    // Services
    if (slots.services.status === 'guessed' && slots.services.userPhrase) {
      slots.services = resolveServices(slots.services, catalog);
    }

    // Staff
    if (slots.staff.status === 'guessed' && slots.staff.userPhrase) {
      slots.staff = resolveStaff(slots.staff, catalog);
    }

    // Staff inference: services resolved (1 servicio) + staff empty/no resolved + ese servicio tiene 1 staff
    if (
      slots.services.status === 'resolved' &&
      Array.isArray(slots.services.value) &&
      slots.services.value.length === 1 &&
      slots.staff.status !== 'resolved'
    ) {
      const serviceUuid = slots.services.value[0];
      const service = catalog.services.find((s) => s.uuid === serviceUuid);
      if (service && service.staff.length === 1) {
        const onlyStaff = service.staff[0];
        if (onlyStaff) {
          slots.staff = {
            value: onlyStaff.uuid,
            displayName: onlyStaff.name,
            status: 'resolved',
          };
          logger.debug('resolveEntities: inferred staff (single option)', {
            serviceUuid,
            staffUuid: onlyStaff.uuid,
          });
        }
      }
    }

    // Client (solo rol=staff agendando para tercero). Find-or-create por teléfono
    // vía Guacuco. Razón (§9.1.3): el cliente no está en el catálogo local.
    if (
      state.identity?.profileType === 'staff' &&
      slots.clientUuid &&
      slots.clientUuid.status === 'guessed' &&
      slots.clientUuid.userPhrase
    ) {
      slots.clientUuid = await resolveClientSlot(slots.clientUuid, state.identity, guacuco, logger);
    }

    return { slots };
  };
}

// ============================================================================
// Client resolution (rol=staff) — única llamada a Guacuco desde resolve_entities
// ============================================================================

async function resolveClientSlot(
  slot: SlotState<string>,
  identity: Identity,
  guacuco: GuacucoClient,
  logger: Logger,
): Promise<SlotState<string>> {
  const { phone, name } = parseClientContact(slot.userPhrase ?? '');

  // Sin teléfono no podemos resolver/crear → queda 'guessed' para re-preguntar.
  if (!phone) {
    return { ...slot, status: 'guessed' };
  }

  try {
    const resolved = await guacuco.resolveClient(
      {
        business_allia_id: identity.tenantAlliaId,
        client_phone: phone,
        ...(name ? { client_name: name } : {}),
      },
      identity,
    );
    return {
      value: resolved.client_uuid,
      displayName: resolved.name,
      userPhrase: slot.userPhrase,
      status: 'resolved',
    };
  } catch (err) {
    // Guacuco caído / error → no spineamos: dejamos 'guessed' (ask_slot re-pide).
    logger.warn('resolveEntities: client resolution failed, keeping guessed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...slot, status: 'guessed' };
  }
}

// ============================================================================
// Service resolution
// ============================================================================

function resolveServices(slot: SlotState<string[]>, catalog: CatalogState): SlotState<string[]> {
  const phrase = slot.userPhrase ?? '';
  const parts = splitServiceParts(phrase);
  const uuids: string[] = [];
  const displayNames: string[] = [];

  for (const part of parts) {
    const match = findServiceByName(catalog.services, part);
    if (!match) {
      return { ...slot, status: 'guessed' };
    }
    uuids.push(match.uuid);
    displayNames.push(match.name);
  }

  if (uuids.length === 0) return { ...slot, status: 'guessed' };

  return {
    value: uuids,
    userPhrase: phrase,
    displayName: displayNames.join(' + '),
    status: 'resolved',
  };
}

function splitServiceParts(phrase: string): string[] {
  return phrase
    .split(/\s+y\s+|\s*\+\s*|\s*,\s*|\s+mas\s+|\s+más\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function findServiceByName(services: CatalogService[], query: string): CatalogService | null {
  const normalized = normalize(query);
  if (normalized.length === 0) return null;
  // Exact match first
  for (const s of services) {
    if (normalize(s.name) === normalized) return s;
  }
  // Substring (both directions)
  for (const s of services) {
    const sn = normalize(s.name);
    if (sn.includes(normalized) || normalized.includes(sn)) return s;
  }
  return null;
}

// ============================================================================
// Staff resolution
// ============================================================================

function resolveStaff(slot: SlotState<string>, catalog: CatalogState): SlotState<string> {
  const phrase = slot.userPhrase ?? '';
  const allStaff = flattenStaff(catalog);
  const match = findStaffByName(allStaff, phrase);
  if (!match) return { ...slot, status: 'guessed' };
  return {
    value: match.uuid,
    displayName: match.name,
    userPhrase: phrase,
    status: 'resolved',
  };
}

function findStaffByName(staff: CatalogStaff[], query: string): CatalogStaff | null {
  const normalized = normalize(query);
  if (normalized.length === 0) return null;
  // Exact match
  for (const s of staff) {
    if (normalize(s.name) === normalized) return s;
  }
  // First name match (frequent in Spanish)
  for (const s of staff) {
    const firstName = s.name.split(/\s+/)[0] ?? '';
    if (normalize(firstName) === normalized) return s;
  }
  // Substring
  for (const s of staff) {
    if (normalize(s.name).includes(normalized)) return s;
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

/** Mensaje terminal cuando el negocio no tiene servicios agendables. */
function emptyCatalogReply(profileType: ProfileType): string {
  if (profileType === 'staff') {
    return 'No encontré servicios con personal asignado en tu negocio. Cargá al menos un servicio y asignale un profesional desde el panel para poder agendar turnos.';
  }
  return 'Por ahora no hay servicios disponibles para agendar. Probá más tarde o escribinos para más información.';
}
