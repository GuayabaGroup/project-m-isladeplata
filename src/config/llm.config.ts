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

function judgeModel(): string {
  return env.LLM_PROVIDER === 'openai' ? env.OPENAI_QUERY_JUDGE_MODEL : env.QUERY_JUDGE_MODEL;
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

/**
 * QueryJudge (freeform_sql). Temperatura 0 (veredicto determinístico),
 * maxTokens moderado (JSON con critique). `failMode` desde env. Ver §11.2.
 */
export const QUERY_JUDGE_CONFIG = {
  model: judgeModel(),
  temperature: 0,
  maxTokens: 512,
  failMode: env.QUERY_JUDGE_FAIL_MODE,
} as const;
