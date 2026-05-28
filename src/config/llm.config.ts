import { env } from './env.js';

/**
 * Configs por rol de LLM. Centralizado acá para que no haya hardcodeo de
 * modelos/temperaturas/maxTokens fuera de este archivo (§11.2 REGLAS).
 *
 * El `model` se resuelve según `env.LLM_PROVIDER` al cargar el módulo —
 * `temperature` y `maxTokens` son agnósticos del provider (ambos SDKs los
 * aceptan con la misma semántica).
 *
 * - `SUPERVISOR_CONFIG`: clasificador de intent. Temperatura baja (determinismo),
 *   maxTokens chico (solo JSON corto).
 * - `RESPONSE_CONFIG`: generación de respuestas conversacionales. Temperatura
 *   media (variedad sin alucinación), maxTokens moderado.
 * - `SOCIAL_CONFIG`: respuestas de fast-path social (greeting/farewell/oos).
 *   Más cortas y conversacionales.
 */

function supervisorModel(): string {
  return env.LLM_PROVIDER === 'openai' ? env.OPENAI_SUPERVISOR_MODEL : env.SUPERVISOR_MODEL;
}

function responseModel(): string {
  return env.LLM_PROVIDER === 'openai' ? env.OPENAI_RESPONSE_MODEL : env.RESPONSE_MODEL;
}

export const SUPERVISOR_CONFIG = {
  model: supervisorModel(),
  temperature: 0.2,
  maxTokens: 256,
} as const;

export const RESPONSE_CONFIG = {
  model: responseModel(),
  temperature: 0.7,
  maxTokens: 300,
} as const;

export const SOCIAL_CONFIG = {
  model: responseModel(),
  temperature: 0.7,
  maxTokens: 150,
} as const;

export type LlmConfig = typeof SUPERVISOR_CONFIG;
