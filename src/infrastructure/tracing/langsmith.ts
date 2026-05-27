import { env, isProduction } from '../../config/env.js';
import { logger } from '../observability/logger.js';

let initialized = false;

/**
 * Initialize LangSmith tracing for LangGraph and LangChain runs.
 *
 * Reads from env vars (LANGSMITH_TRACING + API_KEY + PROJECT + ENDPOINT +
 * HIDE_INPUTS/OUTPUTS) and sets the corresponding LANGCHAIN_* env vars
 * that the SDK detects automatically when LangGraph/LangChain run.
 *
 * No-op if TRACING=false. `warn` log if TRACING=true with empty API_KEY
 * (NEVER throws — tracing absence must not break the agent).
 *
 * Política §13.6 REGLAS: en producción `HIDE_INPUTS` y `HIDE_OUTPUTS`
 * deben ser true salvo justificación documentada. Emitimos warn si se
 * detecta el caso opuesto.
 *
 * Llamar UNA VEZ en bootstrap, antes de compilar el grafo.
 */
export function initLangSmith(): void {
  if (initialized) return;

  if (!env.LANGSMITH_TRACING) {
    logger.info('LangSmith tracing disabled (LANGSMITH_TRACING=false)');
    initialized = true;
    return;
  }

  if (!env.LANGSMITH_API_KEY) {
    logger.warn('LANGSMITH_TRACING=true but LANGSMITH_API_KEY is empty — tracing skipped');
    initialized = true;
    return;
  }

  if (isProduction && (!env.LANGSMITH_HIDE_INPUTS || !env.LANGSMITH_HIDE_OUTPUTS)) {
    logger.warn(
      'LangSmith tracing in production without HIDE_INPUTS=true and HIDE_OUTPUTS=true. ' +
        'Verify the documented justification (see §13.6 REGLAS_ISLADEPLATA).',
    );
  }

  process.env.LANGCHAIN_TRACING_V2 = 'true';
  process.env.LANGCHAIN_API_KEY = env.LANGSMITH_API_KEY;
  process.env.LANGCHAIN_PROJECT = env.LANGSMITH_PROJECT;
  if (env.LANGSMITH_ENDPOINT) {
    process.env.LANGCHAIN_ENDPOINT = env.LANGSMITH_ENDPOINT;
  }
  if (env.LANGSMITH_HIDE_INPUTS) {
    process.env.LANGSMITH_HIDE_INPUTS = 'true';
  }
  if (env.LANGSMITH_HIDE_OUTPUTS) {
    process.env.LANGSMITH_HIDE_OUTPUTS = 'true';
  }

  logger.info('LangSmith tracing enabled', {
    project: env.LANGSMITH_PROJECT,
    hide_inputs: env.LANGSMITH_HIDE_INPUTS,
    hide_outputs: env.LANGSMITH_HIDE_OUTPUTS,
  });
  initialized = true;
}
