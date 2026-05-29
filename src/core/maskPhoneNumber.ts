/**
 * Enmascara un número de teléfono COMPLETO para logs (§13.1.7): conserva los
 * 3 primeros y 2 últimos dígitos para que un operador distinga números sin
 * exponer el valor. Para enmascarar PII embebida en texto libre antes de
 * persistir usar `security/maskPII.ts` (propósito distinto).
 *
 * Vive en `core/` (util puro, sin deps — precedente: `core/parseLlmJson.ts`)
 * porque lo consumen capas que solo pueden importar `core/`/`config/`
 * (ej. `nlg/ResponseBuilder`, §2).
 */
export function maskPhoneNumber(phone: string): string {
  if (phone.length <= 4) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
