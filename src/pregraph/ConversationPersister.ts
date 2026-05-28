import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type {
  PersistAgentTurnAssistantMessage,
  PersistAgentTurnMessage,
  PersistAgentTurnToolCall,
  PersistAgentTurnUserMessage,
  PersistAgentTurnsRequest,
} from '../clients/types/GuacucoTypes.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Identity } from '../core/types/Identity.js';
import type { OutboundReply, Outcome } from '../core/types/Outcome.js';
import { persistTurnTotal } from '../infrastructure/observability/metrics.js';
import { maskPII } from '../security/maskPII.js';

export interface PersistTurnMetadata {
  subgraph?: string;
  toolCalls?: PersistAgentTurnToolCall[];
}

/**
 * Construye el payload P2 y lo envía a Guacuco fire-and-forget al cerrar
 * cada turno del pipeline (§1 PLAN_H8).
 *
 * Reglas:
 * - NUNCA throws — usa swallowAsync. Si Guacuco está caído o responde error,
 *   el turno hacia el usuario ya se dispatcheó; la persistencia es analítica.
 * - thread_id derivado de identity (mismo formato que ThreadResolver).
 * - turn_id generado fresh por cada invocación; idempotencia downstream a
 *   nivel de tabla (Guacuco UNIQUE constraint `(thread_id, turn_id, role)`).
 * - PII (teléfonos, emails) enmascarada antes de persistir.
 */
export class ConversationPersister {
  constructor(
    private readonly guacuco: GuacucoClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Persiste el turno actual (user + assistant si hubo respuesta) en Guacuco.
   * Llamado al final del pipeline, después del dispatch. NEVER throws.
   *
   * Métrica `persist_turn_total{result}` incrementa con `ok` cuando Guacuco
   * acepta (`persisted=true|false` ambos cuentan como ok — el endpoint
   * respondió), `error` cuando hubo throw (red, 5xx, validación).
   */
  async persistTurn(
    message: ChannelMessage,
    identity: Identity,
    outcome: Outcome,
    metadata?: PersistTurnMetadata,
  ): Promise<void> {
    const payload = this.buildPayload(message, identity, outcome, metadata);
    try {
      await this.guacuco.persistAgentTurns(payload);
      persistTurnTotal.labels({ result: 'ok' }).inc();
    } catch (err) {
      persistTurnTotal.labels({ result: 'error' }).inc();
      this.logger.warn('Persist turn failed', {
        thread_id: payload.thread_id,
        turn_id: payload.turn_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Visible para tests + para auditar shape antes del POST. */
  buildPayload(
    message: ChannelMessage,
    identity: Identity,
    outcome: Outcome,
    metadata?: PersistTurnMetadata,
  ): PersistAgentTurnsRequest {
    const turns: PersistAgentTurnMessage[] = [buildUserTurn(message)];
    const assistant = buildAssistantTurn(outcome, metadata);
    if (assistant) turns.push(assistant);

    return {
      tenant_allia_id: identity.tenantAlliaId,
      thread_id: buildThreadId(identity),
      profile_uuid: identity.profileUuid,
      profile_type: identity.profileType,
      channel: identity.channel,
      platform_id: identity.platformId,
      turn_id: randomUUID(),
      turns,
    };
  }
}

function buildThreadId(identity: Identity): string {
  return `${identity.tenantUuid}:${identity.profileUuid}:${identity.channel}:${identity.platformId}`;
}

function buildUserTurn(message: ChannelMessage): PersistAgentTurnUserMessage {
  const turn: PersistAgentTurnUserMessage = {
    role: 'user',
    content: maskPII(message.contentText),
    received_at: message.receivedAt,
    metadata: {
      message_id: message.messageId,
      interactive_payload: message.interactivePayload ?? null,
    },
  };
  return turn;
}

function buildAssistantTurn(
  outcome: Outcome,
  metadata?: PersistTurnMetadata,
): PersistAgentTurnAssistantMessage | null {
  if (!outcome.pendingReply) return null;
  const text = renderReplyAsText(outcome.pendingReply);
  if (!text) return null;

  const turn: PersistAgentTurnAssistantMessage = {
    role: 'assistant',
    content: maskPII(text),
    sent_at: new Date().toISOString(),
    outcome_action: outcome.action,
  };
  if (metadata?.subgraph) turn.subgraph = metadata.subgraph;
  if (metadata?.toolCalls && metadata.toolCalls.length > 0) {
    turn.tool_calls = metadata.toolCalls;
  }
  return turn;
}

/**
 * Render plano del reply para storage analítico (dashboards/CRM). NO se
 * envía al canal — el canal lo formatea via ResponseBuilder. Acá solo
 * importa que el operador humano pueda leer la conversación.
 */
function renderReplyAsText(reply: OutboundReply): string {
  if (reply.cta) {
    return `${reply.cta.text}\n[${reply.cta.displayText}](${reply.cta.url})`;
  }
  if (reply.list) {
    const lines = reply.list.rows.map((r) => {
      const desc = r.description ? ` — ${r.description}` : '';
      return `- ${r.title}${desc}`;
    });
    return [reply.list.body, ...lines].join('\n');
  }
  if (reply.buttons && reply.buttons.length > 0) {
    const body = reply.text ?? '';
    const buttons = reply.buttons.map((b) => `[${b.title}]`).join(' ');
    return body ? `${body}\n${buttons}` : buttons;
  }
  return reply.text ?? '';
}
