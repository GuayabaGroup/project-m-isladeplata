import type { Logger } from 'winston';
import type { WhatsAppSender } from '../channels/whatsapp/sender.js';
import {
  resolveWhatsAppByPhoneNumberId,
  resolveWhatsAppPhoneByRole,
} from '../config/channels.config.js';
import { IdpError } from '../core/errors/IdpError.js';
import type { OutboundMessageDto, OutboundSender } from '../core/types/OutboundMessage.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';
import type { OutboundMessageBuilder } from '../nlg/OutboundMessageBuilder.js';

const DEDUP_NAMESPACE = 'outbound';

export interface OutboundMessageServiceDeps {
  builder: OutboundMessageBuilder;
  sender: WhatsAppSender;
  dedup: DedupStore;
  logger: Logger;
}

/**
 * Orquesta el envío proactivo de un mensaje (Guacuco → IDP → WhatsApp):
 * resuelve el canal emisor por `(role, platformId)`, aplica idempotencia
 * opcional, construye el payload y delega en el `WhatsAppSender`.
 *
 * Recibe `WhatsAppSender` por inyección (no lo construye) — §2. Falla con
 * `IdpError` (nunca `new Error`) para que el handler lo mapee al envelope.
 */
export class OutboundMessageService implements OutboundSender {
  private readonly builder: OutboundMessageBuilder;
  private readonly sender: WhatsAppSender;
  private readonly dedup: DedupStore;
  private readonly logger: Logger;

  constructor(deps: OutboundMessageServiceDeps) {
    this.builder = deps.builder;
    this.sender = deps.sender;
    this.dedup = deps.dedup;
    this.logger = deps.logger;
  }

  async send(dto: OutboundMessageDto): Promise<{ messageId: string }> {
    const phoneNumberId = resolveWhatsAppPhoneByRole(dto.role, dto.platformId);
    if (!phoneNumberId) {
      throw new IdpError(
        'channel_not_configured',
        `No WhatsApp channel configured for role=${dto.role} platformId=${dto.platformId}`,
        { role: dto.role, platformId: dto.platformId },
      );
    }
    const cfg = resolveWhatsAppByPhoneNumberId(phoneNumberId);
    if (!cfg) {
      // Inconsistencia interna del channel map (no debería pasar).
      throw new IdpError(
        'channel_not_configured',
        `Missing config for phoneNumberId=${phoneNumberId}`,
      );
    }

    if (dto.idempotencyKey) {
      const duplicate = await this.dedup.isDuplicate(DEDUP_NAMESPACE, dto.idempotencyKey);
      if (duplicate) {
        // El dedup previene doble envío pero NO retorna el messageId original
        // (DedupStore es boolean-only) — se devuelve vacío a propósito.
        this.logger.info('Outbound message skipped (duplicate idempotency key)', {
          type: dto.type,
          platformId: dto.platformId,
          role: dto.role,
        });
        return { messageId: '' };
      }
    }

    const message = this.builder.build(dto);
    const messageId = await this.sender.send({
      phoneNumberId,
      accessToken: cfg.accessToken,
      message,
    });

    this.logger.info('Outbound message dispatched', {
      type: dto.type,
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
