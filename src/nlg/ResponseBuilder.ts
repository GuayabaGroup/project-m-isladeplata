import type { Logger } from 'winston';
import { CHANNEL_FORMATS, truncate } from '../config/channel-formats.config.js';
import type { OutboundReply } from '../core/types/Outcome.js';
import type { WhatsAppOutboundMessage } from '../core/types/WhatsAppOutbound.js';

/**
 * Formats an `OutboundReply` (the abstract reply shape produced by the
 * pre-graph / graph) into channel-specific payloads, applying the limits
 * declared in `CHANNEL_FORMATS`.
 *
 * `null` return = nothing to send (empty reply). Channel sender must handle
 * this case by skipping the send.
 */
export class ResponseBuilder {
  constructor(private readonly logger: Logger) {}

  buildForWhatsApp(to: string, reply: OutboundReply): WhatsAppOutboundMessage | null {
    const limits = CHANNEL_FORMATS.whatsapp;

    if (reply.cta) {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: truncate(reply.cta.text, limits.bodyMax) },
          action: {
            name: 'cta_url',
            parameters: {
              display_text: truncate(reply.cta.displayText, limits.ctaDisplayTextMax),
              url: reply.cta.url,
            },
          },
        },
      };
    }

    if (reply.list) {
      const rows = reply.list.rows.slice(0, limits.listRowsMax).map((r) => {
        const row: { id: string; title: string; description?: string } = {
          id: r.id,
          title: truncate(r.title, limits.listRowTitleMax),
        };
        if (r.description) {
          row.description = truncate(r.description, limits.listRowDescriptionMax);
        }
        return row;
      });
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: truncate(reply.list.body, limits.bodyMax) },
          action: {
            button: truncate(reply.list.buttonLabel, limits.buttonTitleMax),
            sections: [{ rows }],
          },
        },
      };
    }

    if (reply.buttons && reply.buttons.length > 0) {
      const bodyText = reply.text ?? '';
      const usable = reply.buttons.slice(0, limits.buttonsMax);
      const overflow = reply.buttons.slice(limits.buttonsMax);
      const bodyWithOverflow =
        overflow.length > 0
          ? `${bodyText}\n\n${overflow.map((b, i) => `${i + limits.buttonsMax + 1}. ${b.title}`).join('\n')}`
          : bodyText;
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: truncate(bodyWithOverflow, limits.bodyMax) },
          action: {
            buttons: usable.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: truncate(b.title, limits.buttonTitleMax) },
            })),
          },
        },
      };
    }

    if (reply.text) {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: truncate(reply.text, limits.textMax) },
      };
    }

    this.logger.warn('Empty reply, nothing to send', { to: maskPhone(to) });
    return null;
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
