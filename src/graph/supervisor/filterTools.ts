import type { ProfileType } from '../../core/enums/ProfileType.js';

/**
 * Filtrado de tools / subgrafos por `(profileType, roleId, platformId)` (§10.3 /
 * §10.5 REGLAS). Funciones puras. NO va en el system prompt: el supervisor lo
 * aplica en el router (post-classifier) para evitar que el LLM "imagine" tools
 * que no debe poder invocar.
 *
 * Cascada de resolución para staff (port del IDP viejo `config/toolAccess.ts`):
 *   1. Exact match:        "platformId:roleId"
 *   2. Wildcard platform:  "*:roleId"        (regla por rol, cualquier plataforma)
 *   3. Wildcard role:      "platformId:*"     (regla por plataforma, cualquier rol)
 *   4. Fallback:           STAFF_TOOLS_FALLBACK
 *
 * Los clientes reciben `CLIENT_TOOLS` (role/platform ignorados).
 *
 * Esta cascada es la fuente de verdad AUTORITATIVA del gating en el supervisor.
 * El campo `allowedRoles` de cada `AtomicTool` es metadata defensiva/documental
 * y NO se consume acá — si difieren, manda esta cascada.
 */

export type ToolName =
  // Subgrafos
  | 'schedule'
  | 'reschedule'
  | 'cancel'
  | 'confirm'
  | 'query'
  // Atomic system tools
  | 'retrieve_manzanillo_url'
  | 'generate_verification_url'
  | 'connect_mercado_pago'
  | 'send_client_summary'
  // Support tools
  | 'forward_message';

/** role_id del owner del negocio (convención Guacuco `business_staff_roles.role_id`). */
const OWNER_ROLE_ID = 1;

const CLIENT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'schedule',
  'reschedule',
  'cancel',
  'confirm',
  'query',
  'retrieve_manzanillo_url',
  'generate_verification_url',
  'forward_message',
]);

/** Set completo de staff (owner). Incluye tools owner-only. */
const STAFF_OWNER_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'schedule',
  'reschedule',
  'cancel',
  'confirm',
  'query',
  'generate_verification_url',
  'connect_mercado_pago',
  'send_client_summary',
  'forward_message',
]);

/**
 * Staff no-owner: se quitan las tools owner-only (`connect_mercado_pago` —
 * OAuth financiero; `generate_verification_url` — acceso al panel).
 */
const STAFF_TOOLS_FALLBACK: ReadonlySet<ToolName> = new Set<ToolName>([
  'schedule',
  'reschedule',
  'cancel',
  'confirm',
  'query',
  'send_client_summary',
  'forward_message',
]);

/**
 * Mapa de tools de staff por clave `"platformId:roleId"` (null → "*").
 * Lookup por cascada: exact → wildcard platform → wildcard role → fallback.
 *
 * Hoy todas las plataformas son iguales (solo distingue owner vs no-owner). La
 * estructura ya soporta reglas platform-específicas: para agregar una, sumá un
 * entry con el platformId concreto, ej:
 *   // ['2:1', new Set<ToolName>([...])]  // owner en plataforma 2 (Groomia)
 *   // ['3:*', new Set<ToolName>([...])]  // cualquier rol en plataforma 3 (Allia)
 */
const STAFF_TOOL_MAP: ReadonlyMap<string, ReadonlySet<ToolName>> = new Map([
  // Owner (role_id=1), cualquier plataforma.
  [`*:${OWNER_ROLE_ID}`, STAFF_OWNER_TOOLS],
]);

function buildKey(
  platformId: number | null | undefined,
  roleId: number | null | undefined,
): string {
  const p = platformId != null ? String(platformId) : '*';
  const r = roleId != null ? String(roleId) : '*';
  return `${p}:${r}`;
}

/**
 * Resuelve el set de tools permitidas para una identidad.
 *
 * - client → `CLIENT_TOOLS` (role/platform ignorados).
 * - staff  → cascada en `STAFF_TOOL_MAP`, fallback `STAFF_TOOLS_FALLBACK`.
 */
export function getAvailableTools(
  profileType: ProfileType,
  roleId?: number | null,
  platformId?: number | null,
): ReadonlySet<ToolName> {
  if (profileType === 'client') {
    return CLIENT_TOOLS;
  }

  // 1. Exact match: platformId:roleId
  const exact = STAFF_TOOL_MAP.get(buildKey(platformId, roleId));
  if (exact) return exact;

  // 2. Wildcard platform: *:roleId (regla por rol)
  const wildcardPlatform = STAFF_TOOL_MAP.get(buildKey(null, roleId));
  if (wildcardPlatform) return wildcardPlatform;

  // 3. Wildcard role: platformId:* (regla por plataforma)
  const wildcardRole = STAFF_TOOL_MAP.get(buildKey(platformId, null));
  if (wildcardRole) return wildcardRole;

  // 4. Fallback
  return STAFF_TOOLS_FALLBACK;
}

export function isToolAllowed(
  tool: ToolName,
  profileType: ProfileType,
  roleId?: number | null,
  platformId?: number | null,
): boolean {
  return getAvailableTools(profileType, roleId, platformId).has(tool);
}
