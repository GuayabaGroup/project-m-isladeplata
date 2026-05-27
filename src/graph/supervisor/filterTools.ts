import type { ProfileType } from '../../core/enums/ProfileType.js';

/**
 * Filtrado de tools / subgrafos por rol (§10.3 REGLAS). Función pura. NO va
 * en el system prompt: el supervisor lo aplica antes/después del classifier
 * para evitar que el LLM "imagine" tools que no debe poder invocar.
 *
 * En H3.B el set es chico y estable. Si crece, conviene moverlo a un mapa
 * declarativo por tool con `allowedRoles`.
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
  // Support tools
  | 'forward_message';

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

const STAFF_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'schedule',
  'reschedule',
  'cancel',
  'confirm',
  'query',
  'generate_verification_url',
  'connect_mercado_pago',
  'forward_message',
]);

export function getAvailableTools(profileType: ProfileType): ReadonlySet<ToolName> {
  return profileType === 'staff' ? STAFF_TOOLS : CLIENT_TOOLS;
}

export function isToolAllowed(tool: ToolName, profileType: ProfileType): boolean {
  return getAvailableTools(profileType).has(tool);
}
