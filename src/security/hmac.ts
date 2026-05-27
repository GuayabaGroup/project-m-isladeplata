import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validate a WhatsApp Cloud API webhook signature. HMAC-SHA256 over the
 * RAW request body, compared timing-safe against `X-Hub-Signature-256`.
 *
 * The header value has the shape `sha256=<hex>`. The caller is responsible
 * for passing the raw body (Buffer or string) before any JSON parsing —
 * Express must use `express.raw()` for this route.
 */
export function validateWhatsAppSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const [scheme, providedHex] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !providedHex) return false;

  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (expectedHex.length !== providedHex.length) return false;

  return timingSafeEqual(Buffer.from(expectedHex), Buffer.from(providedHex));
}
