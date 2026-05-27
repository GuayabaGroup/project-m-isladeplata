import type { Logger } from 'winston';
import type { WhatsAppSender } from '../channels/whatsapp/sender.js';
import { resolveWhatsAppByPhoneNumberId } from '../config/channels.config.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { ResponseBuilder } from '../nlg/ResponseBuilder.js';

/**
 * Routes an `Outcome` to the channel-specific sender, formatting via
 * `ResponseBuilder`. Skips dispatch for outcomes without `pendingReply`
 * (ignored / handed_off) and for unsupported channels.
 */
export class ResponseDispatcher {
  constructor(
    private readonly responseBuilder: ResponseBuilder,
    private readonly whatsappSender: WhatsAppSender,
    private readonly logger: Logger,
  ) {}

  async dispatch(message: ChannelMessage, outcome: Outcome): Promise<void> {
    if (!outcome.pendingReply) return;

    if (message.channelType === 'whatsapp') {
      if (!message.phoneNumberId) {
        this.logger.warn('WhatsApp dispatch without phoneNumberId', {
          messageId: message.messageId,
        });
        return;
      }
      const cfg = resolveWhatsAppByPhoneNumberId(message.phoneNumberId);
      if (!cfg) {
        this.logger.warn('Unknown phoneNumberId in dispatch', {
          phoneNumberId: message.phoneNumberId,
        });
        return;
      }
      const waMessage = this.responseBuilder.buildForWhatsApp(
        message.channelId,
        outcome.pendingReply,
      );
      if (!waMessage) return;
      await this.whatsappSender.send({
        phoneNumberId: message.phoneNumberId,
        accessToken: cfg.accessToken,
        message: waMessage,
      });
      return;
    }

    this.logger.warn('Dispatch for unsupported channel', { channel: message.channelType });
  }
}
