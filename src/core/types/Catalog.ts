/**
 * Catálogo de servicios + staff del negocio, normalizado del shape crudo de
 * Guacuco (`identity.helpersLists`). Lo usa el subgrafo `schedule` para fuzzy
 * match local (NO llamadas extra a Guacuco para resolver nombres).
 *
 * Inmutable durante el turno (set por pre-grafo desde el identity resolve).
 */

export interface CatalogStaff {
  uuid: string;
  name: string;
}

export interface CatalogService {
  uuid: string;
  name: string;
  description: string | null;
  price: number | null;
  staff: CatalogStaff[];
}

export interface CatalogState {
  services: CatalogService[];
}

export const EMPTY_CATALOG: CatalogState = { services: [] };

/**
 * Devuelve la lista única de staff de todo el catálogo (sin duplicados).
 * Util para resolveEntities cuando hace fuzzy match de staff sin saber el
 * servicio todavía.
 */
export function flattenStaff(catalog: CatalogState): CatalogStaff[] {
  const seen = new Map<string, CatalogStaff>();
  for (const service of catalog.services) {
    for (const staff of service.staff) {
      if (!seen.has(staff.uuid)) seen.set(staff.uuid, staff);
    }
  }
  return Array.from(seen.values());
}
