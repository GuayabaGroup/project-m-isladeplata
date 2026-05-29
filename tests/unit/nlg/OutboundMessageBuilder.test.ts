import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import type {
  WhatsAppOutboundImage,
  WhatsAppOutboundTemplate,
  WhatsAppOutboundText,
} from '../../../src/channels/whatsapp/types.js';
import type { OutboundMessageDto } from '../../../src/core/types/OutboundMessage.js';
import { OutboundMessageBuilder } from '../../../src/nlg/OutboundMessageBuilder.js';
import { ResponseBuilder } from '../../../src/nlg/ResponseBuilder.js';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeBuilder(): OutboundMessageBuilder {
  return new OutboundMessageBuilder(new ResponseBuilder(mockLogger));
}

describe('OutboundMessageBuilder', () => {
  it('builds a text message', () => {
    const dto: OutboundMessageDto = {
      to: '549111',
      role: 'client',
      platformId: 1,
      type: 'text',
      text: { body: 'hola' },
    };
    const msg = makeBuilder().build(dto) as WhatsAppOutboundText;
    expect(msg.type).toBe('text');
    expect(msg.text.body).toBe('hola');
    expect(msg.messaging_product).toBe('whatsapp');
  });

  it('builds a template with body params and quick-reply buttons (index is string)', () => {
    const dto: OutboundMessageDto = {
      to: '549111',
      role: 'staff',
      platformId: 2,
      type: 'template',
      template: {
        name: 'p2_confirm',
        langCode: 'es',
        parameters: [{ type: 'text', text: 'Juan' }],
        buttons: [{ index: 0, payload: 'confirmar:abc' }],
      },
    };
    const msg = makeBuilder().build(dto) as WhatsAppOutboundTemplate;
    expect(msg.type).toBe('template');
    expect(msg.template.name).toBe('p2_confirm');
    expect(msg.template.language.code).toBe('es');
    expect(msg.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Juan' }] },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'confirmar:abc' }],
      },
    ]);
  });

  it('omits components when template has no params and no buttons', () => {
    const dto: OutboundMessageDto = {
      to: '549111',
      role: 'staff',
      platformId: 1,
      type: 'template',
      template: { name: 'p0_onboarding', langCode: 'es', parameters: [] },
    };
    const msg = makeBuilder().build(dto) as WhatsAppOutboundTemplate;
    expect(msg.template.components).toBeUndefined();
  });

  it('does NOT truncate template parameters', () => {
    const longText = 'x'.repeat(5000);
    const dto: OutboundMessageDto = {
      to: '549111',
      role: 'client',
      platformId: 1,
      type: 'template',
      template: { name: 't', langCode: 'es', parameters: [{ type: 'text', text: longText }] },
    };
    const msg = makeBuilder().build(dto) as WhatsAppOutboundTemplate;
    const body = msg.template.components?.[0];
    expect(body?.type).toBe('body');
    if (body?.type === 'body') {
      expect(body.parameters[0].text).toHaveLength(5000);
    }
  });

  it('builds an image media message', () => {
    const dto: OutboundMessageDto = {
      to: '549111',
      role: 'client',
      platformId: 1,
      type: 'media',
      media: { kind: 'image', link: 'https://x/y.png', caption: 'foto' },
    };
    const msg = makeBuilder().build(dto) as WhatsAppOutboundImage;
    expect(msg.type).toBe('image');
    expect(msg.image).toEqual({ link: 'https://x/y.png', caption: 'foto' });
  });
});
