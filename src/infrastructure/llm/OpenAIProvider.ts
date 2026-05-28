import OpenAI from 'openai';
import type { Logger } from 'winston';
import type {
  LlmCompleteInput,
  LlmCompleteOutput,
  LlmProvider,
  LlmToolCall,
} from './LlmProvider.js';

/**
 * Implementación `LlmProvider` para el SDK OpenAI (§11.1 REGLAS).
 * Único punto del repo que importa `openai` además de tests.
 *
 * Notas de mapeo:
 * - `LlmCompleteInput.system` → mensaje con `role: 'system'` al principio.
 * - `LlmCompleteInput.tools[].input_schema` → `tools[].function.parameters`.
 * - OpenAI distingue `tool_calls` (con `arguments` como JSON string) — se
 *   parsea y se mapea a `LlmToolCall.input: Record<string, unknown>`.
 * - `stop_reason` en Anthropic ≡ `finish_reason` en OpenAI: se devuelve tal
 *   cual (e.g. `'stop'`, `'tool_calls'`, `'length'`). Sólo `'error'` está
 *   reservado por convención cuando el SDK lanza.
 */

export type OpenAIChatCompletionsLike = {
  create(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
};

export interface OpenAIProviderDeps {
  apiKey: string;
  logger: Logger;
  /** Inyectable para tests sin tocar la red. */
  client?: OpenAIChatCompletionsLike;
}

export class OpenAIProvider implements LlmProvider {
  private readonly logger: Logger;
  private readonly chat: OpenAIChatCompletionsLike;

  constructor(deps: OpenAIProviderDeps) {
    this.logger = deps.logger;
    if (deps.client) {
      this.chat = deps.client;
    } else {
      const client = new OpenAI({ apiKey: deps.apiKey });
      this.chat = client.chat.completions as unknown as OpenAIChatCompletionsLike;
    }
  }

  async complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.system },
      ...input.messages.map<OpenAI.Chat.Completions.ChatCompletionMessageParam>((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: input.model,
      max_completion_tokens: input.maxTokens,
      temperature: input.temperature,
      messages,
    };

    if (input.tools && input.tools.length > 0) {
      params.tools = input.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.input_schema,
        },
      }));
    }

    try {
      const response = await this.chat.create(params);
      return parseResponse(response);
    } catch (err) {
      this.logger.warn('OpenAIProvider call failed', {
        model: input.model,
        error: err instanceof Error ? err.message : String(err),
      });
      return blankOutput();
    }
  }
}

function parseResponse(response: OpenAI.Chat.Completions.ChatCompletion): LlmCompleteOutput {
  const choice = response.choices[0];
  const text = (choice?.message?.content ?? '').trim();
  const toolCalls: LlmToolCall[] = [];

  const rawToolCalls = choice?.message?.tool_calls ?? [];
  for (const tc of rawToolCalls) {
    if (tc.type !== 'function') continue;
    let parsed: Record<string, unknown> = {};
    try {
      const raw = tc.function.arguments;
      if (raw && raw.length > 0) {
        const json = JSON.parse(raw) as unknown;
        if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
          parsed = json as Record<string, unknown>;
        }
      }
    } catch {
      // arguments inválidos — dejamos input={} para que el caller decida.
      parsed = {};
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, input: parsed });
  }

  return {
    text,
    toolCalls,
    stopReason: choice?.finish_reason ?? 'unknown',
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
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
