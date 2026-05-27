import type { BaseMessage } from '@langchain/core/messages';
import type { LlmMessage } from './AnthropicProvider.js';

/**
 * Convierte `state.messages` (BaseMessage[] de LangChain) al shape de
 * `messages` que espera el SDK Anthropic. Appendea el turno actual del usuario
 * como último mensaje.
 *
 * Reglas:
 * - Filtra mensajes de tipo `system`/`tool`/`function` — el system prompt va
 *   por el campo `system` del SDK, no en `messages`.
 * - Asegura que el último mensaje sea `user` con el `currentText` provisto;
 *   si `currentText` es vacío, no appendea (caller responsabilidad).
 * - Garantiza alternancia básica `user`/`assistant`: si el historial termina
 *   en `user`, lo conserva pero el caller debería pasar `currentText=''`
 *   para evitar duplicación. En H3.B el caller siempre pasa el turno actual.
 */
export function buildUserMessageChain(
  recentMessages: ReadonlyArray<BaseMessage>,
  currentText: string,
): LlmMessage[] {
  const out: LlmMessage[] = [];

  for (const msg of recentMessages) {
    const role = mapRole(msg);
    if (role === null) continue;
    const content = extractText(msg);
    if (content.length === 0) continue;
    out.push({ role, content });
  }

  if (currentText.length > 0) {
    out.push({ role: 'user', content: currentText });
  }

  return out;
}

function mapRole(msg: BaseMessage): 'user' | 'assistant' | null {
  // BaseMessage subclasses expose `_getType()` returning 'human'|'ai'|'system'|'tool'|...
  const type = (msg as { _getType?: () => string })._getType?.();
  if (type === 'human') return 'user';
  if (type === 'ai') return 'assistant';
  return null;
}

function extractText(msg: BaseMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}
