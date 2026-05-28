/**
 * Contrato LLM-agnóstico. Cualquier código de negocio (supervisor, nodos de
 * subgrafo, etc.) depende de `LlmProvider`, NO de una implementación
 * concreta (§11 REGLAS_ISLADEPLATA).
 *
 * Implementaciones actuales en `src/infrastructure/llm/`:
 *   - `AnthropicProvider` (SDK `@anthropic-ai/sdk`)
 *   - `OpenAIProvider` (SDK `openai`)
 *
 * Selección por env via `createLlmProvider(env, logger)`.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Tool spec con JSON Schema. Forma común entre providers (Anthropic
 * `tools[].input_schema`, OpenAI `tools[].function.parameters`). El mapeo a la
 * shape específica del SDK se hace dentro de cada provider.
 */
export interface LlmToolSpec {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmCompleteInput {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  temperature: number;
  maxTokens: number;
}

export interface LlmCompleteOutput {
  text: string;
  toolCalls: LlmToolCall[];
  /**
   * String libre — cada provider lo emite con su propio vocabulario
   * (`end_turn`, `tool_use`, `stop`, `length`, etc.). Sólo `'error'` es
   * convención interna: lo emiten todas las impls cuando el SDK lanza, así
   * el caller puede detectar fallo uniforme.
   */
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Contrato uniforme entre providers.
 *
 * Contrato de fallo: `complete` NUNCA lanza (§11.3 REGLAS — defaults seguros).
 * Ante fallo del SDK, las impls retornan `{ text: '', toolCalls: [],
 * stopReason: 'error', usage: { inputTokens: 0, outputTokens: 0 } }` y loguean
 * `warn`. El caller decide qué hacer con `text=''` (típicamente fail-open).
 */
export interface LlmProvider {
  complete(input: LlmCompleteInput): Promise<LlmCompleteOutput>;
}
