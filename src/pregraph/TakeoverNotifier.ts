import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { TriggerTakeoverRequest } from '../clients/types/GuacucoTypes.js';
import { env } from '../config/env.js';
import type { TakeoverReasonCode } from '../core/enums/TakeoverReason.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Identity } from '../core/types/Identity.js';
import { takeoverTotal } from '../infrastructure/observability/metrics.js';
import type { TakeoverStore } from '../infrastructure/redis/TakeoverStore.js';
import { maskPII } from '../security/maskPII.js';

/**
 * Summary determinístico por capa (NO call LLM extra — §spec). Sin UUIDs ni PII.
 */
const SUMMARY_BY_REASON: Readonly<Record<TakeoverReasonCode, string>> = {
  explicit_request: 'El cliente pidió explícitamente hablar con una persona.',
  subgraph_handoff:
    'El bot no pudo completar la acción solicitada y derivó la conversación a una persona.',
  repeated_failures: 'El bot no logró resolver la conversación tras varios intentos.',
  sentiment_frustration: 'El cliente muestra señales de frustración o queja repetida.',
  other: 'La conversación requiere intervención humana.',
};

/**
 * Dispara el takeover humano fire-and-forget (análogo a `ConversationPersister`):
 * `GuacucoClient.triggerTakeover` (→ `PATCH support-mode`) + espejo `mirrorActive`
 * en Redis. NUNCA throws — el takeover es un cambio de estado operativo, no parte
 * del flujo conversacional (§spec "Por qué fire-and-forget y no una tool del grafo").
 *
 * Reglas:
 * - El espejo Redis SOLO se setea si el POST resolvió: si Guacuco está caído, el
 *   bot sigue atendiendo (counter `error` + warn lo dejan visible) en lugar de
 *   silenciar una conversación que el dashboard nunca verá.
 * - `summary` determinístico desde la capa que disparó; `last_user_message`
 *   enmascarado con `maskPII`.
 * - `idempotency_key = ${thread_id}:${uuid}` — estable dentro de los reintentos
 *   del `RetryClient` (mismo request); Guacuco dedup por thread activo.
 * - Counter `isladeplata_takeover_total{reason_code, result}`.
 */
export class TakeoverNotifier {
  constructor(
    private readonly guacuco: GuacucoClient,
    private readonly takeoverStore: TakeoverStore,
    private readonly logger: Logger,
  ) {}

  async trigger(
    identity: Identity,
    threadId: string,
    message: ChannelMessage,
    reasonCode: TakeoverReasonCode,
    subgraph: string | null,
  ): Promise<void> {
    const payload = this.buildPayload(identity, threadId, message, reasonCode, subgraph);
    try {
      const result = await this.guacuco.triggerTakeover(payload);
      await this.takeoverStore.mirrorActive(threadId);
      takeoverTotal
        .labels({ reason_code: reasonCode, result: result.created ? 'created' : 'duplicate' })
        .inc();
      this.logger.info('Takeover triggered', {
        thread_id: threadId,
        reason_code: reasonCode,
        created: result.created,
      });
    } catch (err) {
      takeoverTotal.labels({ reason_code: reasonCode, result: 'error' }).inc();
      this.logger.warn('Takeover trigger failed (bot keeps attending)', {
        thread_id: threadId,
        reason_code: reasonCode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Visible para tests + para auditar shape antes del POST. */
  buildPayload(
    identity: Identity,
    threadId: string,
    message: ChannelMessage,
    reasonCode: TakeoverReasonCode,
    subgraph: string | null,
  ): TriggerTakeoverRequest {
    return {
      tenant_allia_id: identity.tenantAlliaId,
      thread_id: threadId,
      profile_uuid: identity.profileUuid,
      profile_type: identity.profileType,
      channel: identity.channel,
      platform_id: identity.platformId,
      reason_code: reasonCode,
      subgraph,
      summary: SUMMARY_BY_REASON[reasonCode],
      last_user_message: maskPII(message.contentText),
      ttl_seconds: env.TAKEOVER_TTL_SECONDS,
      idempotency_key: `${threadId}:${randomUUID()}`,
    };
  }
}
