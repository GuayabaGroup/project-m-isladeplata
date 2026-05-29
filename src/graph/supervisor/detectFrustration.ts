import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../config/llm.config.js';
import { parseLlmJson } from '../../core/parseLlmJson.js';
import type { LlmProvider } from '../../infrastructure/llm/LlmProvider.js';

/**
 * Juez de sentimiento (spec P-human-takeover, capa C). Detecta frustración /
 * insultos / queja repetida. Lo invoca `classifyIntent` (no es un nodo del grafo
 * propio para no inflar el wiring) cuando `HUMAN_TAKEOVER_ENABLED &&
 * TAKEOVER_SENTIMENT_ENABLED`. Si dispara, el clasificador rutea a `request_human`
 * con `takeoverReason='sentiment_frustration'`.
 *
 * Es la ÚNICA capa que puede generar falsos positivos, por eso:
 * - **Fail-closed hacia NO disparar**: ante parse inválido, LLM caído o señal
 *   débil, devuelve `false` (respeta la filosofía anti-falsos-positivos del §spec).
 * - Reusa la config de supervisor (Haiku) — 1 call/turno extra.
 */

export interface FrustrationJudgeDeps {
  llm: LlmProvider;
  logger: Logger;
}

interface FrustrationOutput {
  frustrated: boolean;
  confidence: number;
}

const FRUSTRATION_THRESHOLD = 0.7;

const SYSTEM_PROMPT = `Sos un detector de frustración para un agente de atención al cliente.
Decidí si el ÚLTIMO mensaje del usuario muestra frustración fuerte, enojo, insultos
o una queja repetida que amerite que un HUMANO tome la conversación.

Devolvé SOLO JSON con el shape {"frustrated": boolean, "confidence": number}.

Marcá frustrated=true SOLO ante señales claras: insultos, enojo explícito, "esto no
sirve", "ya te dije mil veces", "son un desastre", amenazas de irse. Una duda normal,
un pedido común o impaciencia leve NO es frustración. Ante la duda, frustrated=false.

confidence: número entre 0 y 1.

Respondé SOLO el JSON, sin prosa ni markdown.`;

/**
 * Construye el juez. Retorna una función `(sanitizedText) => Promise<boolean>`:
 * `true` solo ante frustración clara (>= umbral); `false` en todo el resto
 * (incluido error del LLM / parse). El caller pasa texto YA sanitizado.
 */
export function makeFrustrationJudge(deps: FrustrationJudgeDeps) {
  const { llm, logger } = deps;

  return async function judgeFrustration(sanitizedText: string): Promise<boolean> {
    if (sanitizedText.length === 0) return false;

    let parsed: Partial<FrustrationOutput> | null;
    try {
      const response = await llm.complete({
        ...SUPERVISOR_CONFIG,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: sanitizedText }],
      });
      parsed = parseLlmJson<Partial<FrustrationOutput>>(response.text, logger, {
        component: 'judgeFrustration',
      });
    } catch (err) {
      // Fail-closed: un fallo del juez NO debe disparar takeover.
      logger.warn('judgeFrustration LLM failed (no takeover)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const frustrated =
      parsed?.frustrated === true &&
      typeof parsed.confidence === 'number' &&
      parsed.confidence >= FRUSTRATION_THRESHOLD;

    logger.debug('judgeFrustration', { frustrated, confidence: parsed?.confidence });
    return frustrated;
  };
}
