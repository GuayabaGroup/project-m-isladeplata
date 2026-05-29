import type { Logger } from 'winston';
import {
  resolveWhatsAppByPhoneNumberId,
  resolveWhatsAppPhoneByRole,
} from '../../config/channels.config.js';
import { IdpError } from '../../core/errors/IdpError.js';
import type { ChannelMessage } from '../../core/types/ChannelMessage.js';
import type { OutboundChannelAdapter } from '../../core/types/OutboundChannel.js';
import type { OutboundMessageDto } from '../../core/types/OutboundMessage.js';
import type { OutboundReply } from '../../core/types/Outcome.js';
import type { OutboundMessageBuilder } from '../../nlg/OutboundMessageBuilder.js';
import type { ResponseBuilder } from '../../nlg/ResponseBuilder.js';
import type { WhatsAppSender } from './sender.js';

export interface WhatsAppOutboundAdapterDeps {
  responseBuilder: ResponseBuilder;
  outboundBuilder: OutboundMessageBuilder;
  sender: WhatsAppSender;
  logger: Logger;
}

/**
 * `OutboundChannelAdapter` de WhatsApp. Único lugar que conoce las
 * particularidades de salida de WhatsApp: la clave `phoneNumberId` de
 * `channelMeta`, los lookups de `channels.config`, y el `WhatsAppSender`
 * concreto. Lo resuelven `ResponseDispatcher` (reactivo) y
 * `OutboundMessageService` (proactivo) por `channelType` vía el registry.
 *
 * El formateo se delega a `ResponseBuilder`/`OutboundMessageBuilder` (nlg/),
 * que centralizan los límites de `CHANNEL_FORMATS` (§12.4 REGLAS).
 */
class WhatsAppOutboundAdapter implements OutboundChannelAdapter {
  readonly channelType = 'whatsapp' as const;

  private readonly responseBuilder: ResponseBuilder;
  private readonly outboundBuilder: OutboundMessageBuilder;
  private readonly sender: WhatsAppSender;
  private readonly logger: Logger;

  constructor(deps: WhatsAppOutboundAdapterDeps) {
    this.responseBuilder = deps.responseBuilder;
    this.outboundBuilder = deps.outboundBuilder;
    this.sender = deps.sender;
    this.logger = deps.logger;
  }

  async replyTo(message: ChannelMessage, reply: OutboundReply): Promise<void> {
    const phoneNumberId = message.channelMeta?.phoneNumberId;
    if (!phoneNumberId) {
      this.logger.warn('WhatsApp reply without phoneNumberId', {
        messageId: message.messageId,
      });
      return;
    }
    const cfg = resolveWhatsAppByPhoneNumberId(phoneNumberId);
    if (!cfg) {
      this.logger.warn('Unknown phoneNumberId in reply', { phoneNumberId });
      return;
    }
    const waMessage = this.responseBuilder.buildForWhatsApp(message.channelId, reply);
    if (!waMessage) return;
    await this.sender.send({
      phoneNumberId,
      accessToken: cfg.accessToken,
      message: waMessage,
    });
  }

  async sendProactive(dto: OutboundMessageDto): Promise<{ messageId: string }> {
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

    const message = this.outboundBuilder.build(dto);
    const messageId = await this.sender.send({
      phoneNumberId,
      accessToken: cfg.accessToken,
      message,
    });
    return { messageId };
  }
}

/** Factory del adapter de salida de WhatsApp (lo wirea `bootstrap.ts`). */
export function createWhatsAppOutboundAdapter(
  deps: WhatsAppOutboundAdapterDeps,
): OutboundChannelAdapter {
  return new WhatsAppOutboundAdapter(deps);
}
