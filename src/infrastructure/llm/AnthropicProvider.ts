import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'winston';

/**
 * Único wrapper del SDK Anthropic en el repo (§9.2 REGLAS_ISLADEPLATA).
 * Cualquier nodo LLM debe inyectar este provider — NO importar el SDK
 * directamente fuera de este archivo.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Tool spec con JSON Schema. Tipado laxo a propósito para no acoplar a la
 * versión del SDK Anthropic.
 */
export interface AnthropicToolSpec {
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
  tools?: AnthropicToolSpec[];
  temperature: number;
  maxTokens: number;
}

export interface LlmCompleteOutput {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Mínima superficie del SDK que consumimos. Inyectable en tests sin tocar la
 * red.
 */
export type AnthropicMessagesLike = {
  create(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Messages.Message>;
};

export interface AnthropicProviderDeps {
  apiKey: string;
  logger: Logger;
  /** Inyectable para tests sin tocar la red. */
  client?: AnthropicMessagesLike;
}

export class AnthropicProvider {
  private readonly logger: Logger;
  private readonly messages: AnthropicMessagesLike;

  constructor(deps: AnthropicProviderDeps) {
    this.logger = deps.logger;
    if (deps.client) {
      this.messages = deps.client;
    } else {
      const client = new Anthropic({ apiKey: deps.apiKey });
      this.messages = client.messages as unknown as AnthropicMessagesLike;
    }
  }

  /**
   * Llamada bloqueante al SDK. NUNCA lanza (§9.4 — defaults seguros) — ante
   * fallo, retorna shape vacío + log warn. El caller decide qué hacer con un
   * `text=''` (típicamente: fail-open a un default seguro).
   *
   * Sin streaming en H3.B: cada call es non-streaming `messages.create`.
   */
  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: input.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      system: input.system,
      messages: input.messages,
    };
    if (input.tools && input.tools.length > 0) {
      // El SDK exige `input_schema.type === 'object'` en su tipo; mantenemos
      // nuestro tipo `AnthropicToolSpec` laxo y validamos en el caller.
      params.tools = input.tools as unknown as Anthropic.Messages.Tool[];
    }

    try {
      const response = await this.messages.create(params);
      return parseMessage(response);
    } catch (err) {
      this.logger.warn('AnthropicProvider call failed', {
        model: input.model,
        error: err instanceof Error ? err.message : String(err),
      });
      return blankOutput();
    }
  }
}

function parseMessage(response: Anthropic.Messages.Message): LlmCompleteOutput {
  const texts: string[] = [];
  const toolCalls: LlmToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
      });
    }
    // Ignoramos otros tipos (thinking, server_tool_use, etc.) — no aplican en H3.B.
  }

  return {
    text: texts.join('').trim(),
    toolCalls,
    stopReason: response.stop_reason ?? 'unknown',
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function blankOutput(): LlmCompleteOutput {
  return {
    text: '',
    toolCalls: [],
    stopReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
