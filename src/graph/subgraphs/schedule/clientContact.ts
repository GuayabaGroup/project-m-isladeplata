/**
 * Extrae teléfono + nombre del texto libre con el que un staff identifica a un
 * cliente (ej: "juan +5491134498081", "Juan 1134498081", "1134498081").
 *
 * Función pura, determinística — NO llama LLM. El teléfono es la clave de
 * resolución/creación en Guacuco (`getOrCreateByPhone` normaliza a dígitos), así
 * que sin un número con suficientes dígitos retornamos `phone: null` y el
 * subgrafo vuelve a pedirlo.
 */

/** Mínimo de dígitos para considerar un token como teléfono (alinea con Guacuco). */
const MIN_PHONE_DIGITS = 7;

/** Token tipo teléfono: opcional `+`, dígitos y separadores comunes (espacios, -, (), .). */
const PHONE_TOKEN = /\+?\d[\d\s().-]{5,}\d/;

export interface ClientContact {
  /** Teléfono tal como lo escribió el usuario (sin normalizar), o null. */
  phone: string | null;
  /** Nombre (lo que queda al remover el teléfono), o null si no quedó texto. */
  name: string | null;
}

export function parseClientContact(text: string): ClientContact {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { phone: null, name: null };

  const match = trimmed.match(PHONE_TOKEN);
  if (!match) {
    // No hay token telefónico — todo es (posible) nombre, pero sin teléfono no
    // podemos resolver/crear.
    return { phone: null, name: null };
  }

  const phoneRaw = match[0];
  const digits = phoneRaw.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) {
    return { phone: null, name: null };
  }

  // El nombre es lo que queda al remover el token telefónico. Limpiamos
  // separadores/puntuación colgante en los bordes (ej. "Maria (" → "Maria").
  const name = trimmed
    .replace(phoneRaw, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s(),.+-]+|[\s(),.+-]+$/g, '')
    .trim();

  return {
    phone: phoneRaw.trim(),
    name: name.length > 0 ? name : null,
  };
}
