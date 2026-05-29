import type { ProfileType } from '../../core/enums/ProfileType.js';

/**
 * Mapeo de platform ID → nombre por defecto del asistente, y lógica de
 * resolución según quién escribe (staff vs client).
 *
 * Vive en `config/` (importa solo de `core/`, §2 REGLAS) porque es
 * configuración pura consumida por la capa de personalidad.
 *
 * Reglas:
 *  - Staff siempre recibe el nombre por defecto de la plataforma (Ally / Groomy / Divy).
 *  - Cliente recibe `agentName` (custom del negocio) si está definido, sino el default.
 *
 * Portado de `project-m-idp/src/config/assistantName.ts`.
 */

const PLATFORM_DEFAULT_NAMES: Record<number, string> = {
  1: 'Ally',
  2: 'Groomy',
  3: 'Divy',
};

export function resolveAssistantName(
  platformId: number,
  profileType: ProfileType,
  agentName: string | null,
): string {
  if (profileType === 'staff') {
    return PLATFORM_DEFAULT_NAMES[platformId] ?? 'Ally';
  }
  return agentName?.trim() || PLATFORM_DEFAULT_NAMES[platformId] || 'Ally';
}
