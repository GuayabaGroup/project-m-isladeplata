import type {
  WhatsAppOutboundMessage,
  WhatsAppTemplateComponent,
} from '../channels/whatsapp/types.js';
import { IdpError } from '../core/errors/IdpError.js';
import type { OutboundMessageDto, OutboundTemplateDto } from '../core/types/OutboundMessage.js';
import type { OutboundReply } from '../core/types/Outcome.js';
import type { ResponseBuilder } from './ResponseBuilder.js';

/**
 * Mapea un `OutboundMessageDto` (contrato S2S agnóstico) al payload concreto de
 * WhatsApp Cloud API.
 *
 * `text` e `interactive` se delegan a `ResponseBuilder` para reusar EXACTAMENTE
 * los límites de `CHANNEL_FORMATS` (truncación de body/títulos, cap de botones).
 * `template` y `media` se construyen acá: los parámetros de template NO se
 * truncan (Meta valida el HSM contra la plantilla aprobada; truncar corrompería
 * el valor).
 */
export class OutboundMessageBuilder {
  constructor(private readonly responseBuilder: ResponseBuilder) {}

  build(dto: OutboundMessageDto): WhatsAppOutboundMessage {
    switch (dto.type) {
      case 'text':
        return this.fromReply(dto.to, { text: dto.text.body });
      case 'interactive':
        return this.buildInteractive(dto.to, dto.interactive);
      case 'template':
        return this.buildTemplate(dto);
      case 'media':
        return this.buildMedia(dto);
    }
  }

  private buildInteractive(
    to: string,
    interactive: Extract<OutboundMessageDto, { type: 'interactive' }>['interactive'],
  ): WhatsAppOutboundMessage {
    switch (interactive.kind) {
      case 'buttons':
        return this.fromReply(to, { text: interactive.body, buttons: interactive.buttons });
      case 'list':
        return this.fromReply(to, { list: interactive.list });
      case 'cta':
        return this.fromReply(to, { cta: interactive.cta });
    }
  }

  /** Delegación a ResponseBuilder + guard de reply vacío. */
  private fromReply(to: string, reply: OutboundReply): WhatsAppOutboundMessage {
    const message = this.responseBuilder.buildForWhatsApp(to, reply);
    if (!message) {
      throw new IdpError('empty_message', 'Outbound message resolved to empty payload');
    }
    return message;
  }

  private buildTemplate(dto: OutboundTemplateDto): WhatsAppOutboundMessage {
    const { name, langCode, parameters, buttons } = dto.template;
    const components: WhatsAppTemplateComponent[] = [];
    if (parameters.length > 0) {
      components.push({ type: 'body', parameters });
    }
    for (const btn of buttons ?? []) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(btn.index),
        parameters: [{ type: 'payload', payload: btn.payload }],
      });
    }
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: dto.to,
      type: 'template',
      template: {
        name,
        language: { code: langCode },
        ...(components.length > 0 ? { components } : {}),
      },
    };
  }

  private buildMedia(dto: Extract<OutboundMessageDto, { type: 'media' }>): WhatsAppOutboundMessage {
    const { kind, link, caption, filename } = dto.media;
    if (kind === 'image') {
      return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: dto.to,
        type: 'image',
        image: { link, ...(caption ? { caption } : {}) },
      };
    }
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: dto.to,
      type: 'document',
      document: {
        link,
        ...(caption ? { caption } : {}),
        ...(filename ? { filename } : {}),
      },
    };
  }
}
