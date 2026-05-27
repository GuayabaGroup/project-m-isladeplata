import { env } from './env.js';

/**
 * Configs por rol de LLM. Centralizado acá para que no haya hardcodeo de
 * modelos/temperaturas/maxTokens fuera de este archivo (§9.3 REGLAS).
 *
 * - `SUPERVISOR_CONFIG`: clasificador de intent. Temperatura baja (determinismo),
 *   maxTokens chico (solo JSON corto).
 * - `RESPONSE_CONFIG`: generación de respuestas conversacionales. Temperatura
 *   media (variedad sin alucinación), maxTokens moderado.
 * - `SOCIAL_CONFIG`: respuestas de fast-path social (greeting/farewell/oos).
 *   Más cortas y conversacionales.
 */
export const SUPERVISOR_CONFIG = {
  model: env.SUPERVISOR_MODEL,
  temperature: 0.2,
  maxTokens: 256,
} as const;

export const RESPONSE_CONFIG = {
  model: env.RESPONSE_MODEL,
  temperature: 0.7,
  maxTokens: 300,
} as const;

export const SOCIAL_CONFIG = {
  model: env.RESPONSE_MODEL,
  temperature: 0.7,
  maxTokens: 150,
} as const;

export type LlmConfig = typeof SUPERVISOR_CONFIG;
