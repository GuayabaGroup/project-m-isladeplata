/**
 * Resuelve el schema Postgres permitido por el rol del consultor.
 *
 * Mapeo (portado de IDP_OV1):
 *   - client            → front_sche_client
 *   - staff role_id=1   → front_sche                (Owner)
 *   - staff role_id=2   → front_sche_professional
 *   - staff role_id=3   → front_sche_admin
 *   - staff sin roleId  → rechaza (no se puede determinar scope)
 */

export interface SchemaResolutionOk {
  ok: true;
  allowedSchema: string;
}

export interface SchemaResolutionError {
  ok: false;
  reason: string;
}

export type SchemaResolutionResult = SchemaResolutionOk | SchemaResolutionError;

const SCHEMA_CLIENT = 'front_sche_client';
const SCHEMA_STAFF_OWNER = 'front_sche';
const SCHEMA_STAFF_PROFESSIONAL = 'front_sche_professional';
const SCHEMA_STAFF_ADMIN = 'front_sche_admin';

const STAFF_ROLE_SCHEMA_MAP: Record<number, string> = {
  2: SCHEMA_STAFF_PROFESSIONAL,
  3: SCHEMA_STAFF_ADMIN,
};

export function resolveAllowedSchema(
  profileType: 'client' | 'staff',
  roleId: number | null | undefined,
): SchemaResolutionResult {
  if (profileType === 'client') {
    return { ok: true, allowedSchema: SCHEMA_CLIENT };
  }
  if (roleId == null) {
    return {
      ok: false,
      reason: 'No se pudo determinar el rol del usuario para acceder a la base de datos.',
    };
  }
  const schema = STAFF_ROLE_SCHEMA_MAP[roleId] ?? SCHEMA_STAFF_OWNER;
  return { ok: true, allowedSchema: schema };
}
