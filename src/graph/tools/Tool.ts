import type { Logger } from 'winston';
import type { GuacucoClient } from '../../clients/GuacucoClient.js';
import type { ProfileType } from '../../core/enums/ProfileType.js';
import type { LlmProvider } from '../../infrastructure/llm/LlmProvider.js';
import type { GraphState, GraphStateUpdate } from '../state.js';

/**
 * Interfaz común de tools atómicas (las que cuelgan directo del supervisor,
 * sin estado intermedio, single-turn).
 *
 * Las tools NO lanzan: ante fallo del backend, producen un outcome `error`
 * con texto neutro. Esto es §9.4 REGLAS (defaults seguros) — pelearse con
 * el LLM o intentar reintentos creativos invita a bugs.
 */
export interface ToolDeps {
  guacuco: GuacucoClient;
  logger: Logger;
  /**
   * Provider LLM. `forward_message` lo usa para resumir el mensaje + contexto
   * antes de reenviarlo al negocio; es la primera tool atómica que llama al LLM.
   */
  llm: LlmProvider;
}

export interface AtomicTool {
  name: string;
  allowedRoles: ReadonlyArray<ProfileType>;
  run(state: GraphState, deps: ToolDeps): Promise<GraphStateUpdate>;
}
