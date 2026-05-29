/**
 * Razón por la que se dispara el takeover humano (spec P-human-takeover).
 * Mapea 1:1 a las capas de detección:
 *   - `explicit_request`     → capa A (el cliente pide explícitamente un humano)
 *   - `repeated_failures`    → capa B (N salidas handed_off/error consecutivas)
 *   - `sentiment_frustration`→ capa C (juez LLM de frustración)
 *   - `other`                → reservado (disparos futuros / fallback)
 *
 * Es el `reason_code` del contrato HTTP hacia Guacuco y el label de la métrica
 * `isladeplata_takeover_total`.
 */
export const TAKEOVER_REASON_CODES = [
  'explicit_request',
  'repeated_failures',
  'sentiment_frustration',
  'other',
] as const;

export type TakeoverReasonCode = (typeof TAKEOVER_REASON_CODES)[number];
