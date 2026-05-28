// Patterns conservative: detect PII para no enviar bruto al storage de Guacuco
// (dashboards/CRM ven contenido persistido). NO bloquean usage downstream;
// son cosmetic masking previo a persistir el turno.
//
// - Email: parte local truncada a 2 chars + dominio preservado.
// - Teléfono: 8-15 dígitos con separadores opcionales (espacios, guiones,
//   puntos, paréntesis, prefijo +). Reemplazo conserva los últimos 2 dígitos
//   para que el operador humano todavía pueda distinguir entre números.

const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE_RE = /(\+?\d[\d\s().-]{7,18}\d)/g;

function maskEmail(local: string, domain: string): string {
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 8) return match;
  return `***${digits.slice(-2)}`;
}

/**
 * Enmascara teléfonos y emails en texto libre antes de persistir.
 *
 * Idempotente: corre dos pasadas (email primero porque puede contener dígitos
 * en el local part) y devuelve string vacío para input no string. NUNCA
 * lanza — está pensado para ejecutarse en el path de fire-and-forget.
 */
export function maskPII(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  const noEmails = input.replace(EMAIL_RE, (_m, local: string, domain: string) =>
    maskEmail(local, domain),
  );
  return noEmails.replace(PHONE_RE, (m: string) => maskPhone(m));
}
