import type { Logger } from 'winston';
import { IdpError } from '../core/errors/IdpError.js';
import type { OutboundChannelRegistry } from '../core/types/OutboundChannel.js';
import type { OutboundMessageDto, OutboundSender } from '../core/types/OutboundMessage.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';

const DEDUP_NAMESPACE = 'outbound';

export interface OutboundMessageServiceDeps {
  registry: OutboundChannelRegistry;
  dedup: DedupStore;
  logger: Logger;
}

/**
 * Orquesta el envío proactivo S2S (Guacuco → IDP → canal): resuelve el
 * `OutboundChannelAdapter` por `dto.channelType`, aplica idempotencia opcional
 * (Redis — de la que ESTE servicio es dueño), y delega resolve+format+send en
 * el adapter del canal.
 *
 * Channel-agnóstico: sin `if channelType === 'x'` (§12.3 / §12.6 REGLAS).
 * Recibe el registry por inyección — §2. Falla con `IdpError` (nunca
 * `new Error`) para que el handler lo mapee al envelope.
 */
export class OutboundMessageService implements OutboundSender {
  private readonly registry: OutboundChannelRegistry;
  private readonly dedup: DedupStore;
  private readonly logger: Logger;

  constructor(deps: OutboundMessageServiceDeps) {
    this.registry = deps.registry;
    this.dedup = deps.dedup;
    this.logger = deps.logger;
  }

  async send(dto: OutboundMessageDto): Promise<{ messageId: string }> {
    const adapter = this.registry.get(dto.channelType);
    if (!adapter) {
      throw new IdpError(
        'channel_not_configured',
        `No outbound adapter registered for channel=${dto.channelType}`,
        { channelType: dto.channelType },
      );
    }

    if (dto.idempotencyKey) {
      const duplicate = await this.dedup.isDuplicate(DEDUP_NAMESPACE, dto.idempotencyKey);
      if (duplicate) {
        // El dedup previene doble envío pero NO retorna el messageId original
        // (DedupStore es boolean-only) — se devuelve vacío a propósito.
        this.logger.info('Outbound message skipped (duplicate idempotency key)', {
          type: dto.type,
          channelType: dto.channelType,
          platformId: dto.platformId,
          role: dto.role,
        });
        return { messageId: '' };
      }
    }

    const { messageId } = await adapter.sendProactive(dto);

    this.logger.info('Outbound message dispatched', {
      type: dto.type,
      channelType: dto.channelType,
      platformId: dto.platformId,
      role: dto.role,
      to: maskPhone(dto.to),
      messageId,
    });

    return { messageId };
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
