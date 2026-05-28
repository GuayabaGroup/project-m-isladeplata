import type { Logger } from 'winston';
import type { Env } from '../../config/env.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import type { LlmProvider } from './LlmProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';

/**
 * Factory del `LlmProvider` activo. Switchea por `env.LLM_PROVIDER` y exige
 * que la API key del provider elegido esté presente (fail-fast con mensaje
 * explícito al boot — §11.1 REGLAS).
 *
 * Los modelos por rol se resuelven en `config/llm.config.ts` según el mismo
 * `LLM_PROVIDER`, así que este factory sólo se preocupa por instanciar la
 * impl correcta.
 */
export function createLlmProvider(env: Env, logger: Logger): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case 'anthropic': {
      if (env.ANTHROPIC_API_KEY.length === 0) {
        throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY (got empty string)');
      }
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, logger });
    }
    case 'openai': {
      if (env.OPENAI_API_KEY.length === 0) {
        throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY (got empty string)');
      }
      return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, logger });
    }
  }
}
