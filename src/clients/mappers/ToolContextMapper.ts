import type { Identity } from '../../core/types/Identity.js';
import type { ToolContext } from '../types/GuacucoTypes.js';

/**
 * Builder ÚNICO del sobre de identidad (`context`) que isladeplata envía en
 * TODA tool execute hacia Guacuco. Es el único punto autorizado a convertir
 * `state.identity` → `ToolContext`.
 *
 * Reemplaza los dicts de context armados a mano en commit nodes, atomic tools y
 * los métodos del client. Garantiza que el guard cross-business de Guacuco
 * (defense-in-depth §9/§13.1 REGLAS) reciba SIEMPRE las mismas keys, derivadas
 * del state — nunca del LLM ni del payload del usuario.
 *
 * `business_allia_id` NO se incluye: Guacuco no lo lee de `context` (lo descarta
 * el `ToolMapper`), va como `parameter` en las tools que lo requieren.
 */
export function toolContextFromIdentity(identity: Identity): ToolContext {
  const context: ToolContext = {
    profile_uuid: identity.profileUuid,
    profile_type: identity.profileType,
    business_uuid: identity.tenantUuid,
  };
  if (identity.roleId != null) context.role_id = identity.roleId;
  return context;
}
