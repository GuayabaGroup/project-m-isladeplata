/**
 * Razón por la que se dispara el takeover humano (spec P-human-takeover).
 *   - `explicit_request`     → capa A (el cliente pide explícitamente un humano)
 *   - `subgraph_handoff`     → un subgrafo abandonó (anti-loop, commit fallido,
 *                              sin disponibilidad) tras prometerle contacto
 *                              humano al usuario → escalación INMEDIATA.
 *   - `repeated_failures`    → capa B (N salidas `error` inesperadas consecutivas)
 *   - `sentiment_frustration`→ capa C (juez LLM de frustración)
 *   - `other`                → fallback (ej. gap de contenido de plataforma)
 *
 * Es el `reason_code` del contrato HTTP hacia Guacuco y el label de la métrica
 * `isladeplata_takeover_total`.
 */
export const TAKEOVER_REASON_CODES = [
  'explicit_request',
  'subgraph_handoff',
  'repeated_failures',
  'sentiment_frustration',
  'other',
] as const;

export type TakeoverReasonCode = (typeof TAKEOVER_REASON_CODES)[number];
