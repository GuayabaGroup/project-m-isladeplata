import { describe, expect, it } from 'vitest';
import {
  extractPhoneNumberIdUntrusted,
  normalizeWhatsAppPayload,
} from '../../../../src/channels/whatsapp/normalizer.js';
import type { WhatsAppInboundPayload } from '../../../../src/channels/whatsapp/types.js';

function buildPayload(messages: unknown[], phoneNumberId = 'pn-123'): WhatsAppInboundPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId, display_phone_number: '+5491100000' },
              contacts: [{ profile: { name: 'Juan' }, wa_id: '54911000000' }],
              messages: messages as never,
            },
          },
        ],
      },
    ],
  };
}

describe('normalizeWhatsAppPayload — text', () => {
  it('maps a text message to ChannelMessage', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.ABC',
        timestamp: '1764259200',
        type: 'text',
        text: { body: 'hola' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channelType: 'whatsapp',
      channelId: '54911000000',
      messageId: 'wamid.ABC',
      contentText: 'hola',
      whatsappChannel: 'client',
      phoneNumberId: 'pn-123',
      userName: 'Juan',
      interactivePayload: null,
    });
    expect(result[0]?.receivedAt).toMatch(/^2025/);
  });

  it('returns empty array when no messages', () => {
    const payload = buildPayload([]);
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });

  it('skips messages without from/id', () => {
    const payload = buildPayload([
      { type: 'text', text: { body: 'orphan' } },
      { id: 'wamid.XYZ', type: 'text', text: { body: 'no from' } },
    ]);
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });
});

describe('normalizeWhatsAppPayload — interactive', () => {
  it('maps button_reply to interactivePayload', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.BTN',
        timestamp: '1764259200',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'confirm:abc-123', title: 'Confirmar' },
        },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'staff');
    expect(result[0]).toMatchObject({
      contentText: 'Confirmar',
      interactivePayload: { type: 'button', id: 'confirm:abc-123', title: 'Confirmar' },
      whatsappChannel: 'staff',
    });
  });

  it('maps list_reply to interactivePayload', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.LIST',
        timestamp: '1764259200',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'slot:0', title: '4 de marzo - 10:00' },
        },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]?.interactivePayload).toEqual({
      type: 'list',
      id: 'slot:0',
      title: '4 de marzo - 10:00',
    });
  });

  it('skips unknown interactive subtype', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.UNK',
        timestamp: '1764259200',
        type: 'interactive',
        interactive: { type: 'unknown_thing' },
      },
    ]);
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });
});

describe('normalizeWhatsAppPayload — non-message events', () => {
  it('returns empty array when payload has only statuses', () => {
    const payload: WhatsAppInboundPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'pn-1' },
                statuses: [{ id: 'wamid.X', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });

  it('skips sticker/reaction (unknown types not in the switch)', () => {
    const payload = buildPayload([
      { from: '54911000000', id: 'wamid.STK', timestamp: '1764259200', type: 'sticker' },
    ]);
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });
});

describe('normalizeWhatsAppPayload — template_button', () => {
  it('captures contextMessageId + payload AND keeps interactivePayload for routing', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.TPL',
        timestamp: '1764259200',
        type: 'button',
        button: { text: 'Confirmar', payload: 'confirm:appt-9' },
        context: { id: 'wamid.ORIGINAL_TEMPLATE' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]).toMatchObject({
      contentType: 'template_button',
      contentText: 'Confirmar',
      templateButton: { contextMessageId: 'wamid.ORIGINAL_TEMPLATE', payload: 'confirm:appt-9' },
      interactivePayload: { type: 'button', id: 'confirm:appt-9', title: 'Confirmar' },
    });
  });
});

describe('normalizeWhatsAppPayload — media + location', () => {
  it('maps image: caption → contentText + media carried', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.IMG',
        timestamp: '1764259200',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'mi foto' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]).toMatchObject({
      contentType: 'image',
      contentText: 'mi foto',
      media: { id: 'media-1', mimeType: 'image/jpeg', caption: 'mi foto', sha256: 'abc' },
    });
  });

  it('maps audio: empty contentText (no caption in Meta)', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.AUD',
        timestamp: '1764259200',
        type: 'audio',
        audio: { id: 'media-2', mime_type: 'audio/ogg' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]).toMatchObject({
      contentType: 'audio',
      contentText: '',
      media: { id: 'media-2', mimeType: 'audio/ogg' },
    });
  });

  it('maps document: filename carried', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.DOC',
        timestamp: '1764259200',
        type: 'document',
        document: { id: 'media-3', mime_type: 'application/pdf', filename: 'factura.pdf' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]).toMatchObject({
      contentType: 'document',
      media: { id: 'media-3', mimeType: 'application/pdf', filename: 'factura.pdf' },
    });
  });

  it('maps location: name → contentText + lat/long carried', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.LOC',
        timestamp: '1764259200',
        type: 'location',
        location: { latitude: -34.6, longitude: -58.4, name: 'Obelisco' },
      },
    ]);
    const result = normalizeWhatsAppPayload(payload, 'client');
    expect(result[0]).toMatchObject({
      contentType: 'location',
      contentText: 'Obelisco',
      location: { latitude: -34.6, longitude: -58.4, name: 'Obelisco' },
    });
  });

  it('drops a location without coordinates', () => {
    const payload = buildPayload([
      {
        from: '54911000000',
        id: 'wamid.LOC2',
        timestamp: '1764259200',
        type: 'location',
        location: {},
      },
    ]);
    expect(normalizeWhatsAppPayload(payload, 'client')).toEqual([]);
  });
});

describe('extractPhoneNumberIdUntrusted', () => {
  it('extracts phone_number_id from valid JSON body', () => {
    const body = JSON.stringify(buildPayload([], 'pn-42'));
    expect(extractPhoneNumberIdUntrusted(body)).toBe('pn-42');
  });

  it('returns null on malformed JSON', () => {
    expect(extractPhoneNumberIdUntrusted('not json {{')).toBeNull();
  });

  it('returns null on JSON without metadata', () => {
    expect(extractPhoneNumberIdUntrusted('{"foo":"bar"}')).toBeNull();
  });

  it('handles Buffer input', () => {
    const body = Buffer.from(JSON.stringify(buildPayload([], 'pn-buf')));
    expect(extractPhoneNumberIdUntrusted(body)).toBe('pn-buf');
  });
});
