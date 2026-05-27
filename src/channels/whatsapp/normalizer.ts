import type { ChannelMessage } from '../../core/types/ChannelMessage.js';
import type { WhatsAppInboundMessage, WhatsAppInboundPayload } from './types.js';

/**
 * Walk a WhatsApp Cloud API webhook payload and emit one `ChannelMessage`
 * per actual user message inside.
 *
 * Filters out non-message events (statuses, deletes). For supported message
 * types (text, interactive button_reply, interactive list_reply, button)
 * returns a normalized object; otherwise emits with `contentText=''` so
 * downstream can decide whether to respond.
 *
 * `whatsappChannel` viene del config map (staff vs client) ya resuelto por
 * `resolveWhatsAppByPhoneNumberId(phone_number_id)`.
 */
export function normalizeWhatsAppPayload(
  payload: WhatsAppInboundPayload,
  whatsappChannel: 'staff' | 'client',
): ChannelMessage[] {
  const out: ChannelMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value || value.messaging_product !== 'whatsapp') continue;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const userName = value.contacts?.[0]?.profile?.name;

      for (const msg of value.messages ?? []) {
        const normalized = mapMessage(msg, phoneNumberId, whatsappChannel, userName);
        if (normalized) out.push(normalized);
      }
    }
  }

  return out;
}

function mapMessage(
  msg: WhatsAppInboundMessage,
  phoneNumberId: string,
  whatsappChannel: 'staff' | 'client',
  userName: string | undefined,
): ChannelMessage | null {
  const channelId = msg.from;
  const messageId = msg.id;
  if (!channelId || !messageId) return null;

  const base = {
    channelType: 'whatsapp' as const,
    channelId,
    messageId,
    receivedAt: msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000).toISOString()
      : new Date().toISOString(),
    whatsappChannel,
    phoneNumberId,
    userName,
  };

  switch (msg.type) {
    case 'text':
      return {
        ...base,
        contentText: msg.text?.body ?? '',
        interactivePayload: null,
      };
    case 'interactive': {
      const inter = msg.interactive;
      if (inter?.type === 'button_reply' && inter.button_reply?.id) {
        return {
          ...base,
          contentText: inter.button_reply.title ?? '',
          interactivePayload: {
            type: 'button',
            id: inter.button_reply.id,
            title: inter.button_reply.title,
          },
        };
      }
      if (inter?.type === 'list_reply' && inter.list_reply?.id) {
        return {
          ...base,
          contentText: inter.list_reply.title ?? '',
          interactivePayload: {
            type: 'list',
            id: inter.list_reply.id,
            title: inter.list_reply.title,
          },
        };
      }
      return null;
    }
    case 'button':
      return {
        ...base,
        contentText: msg.button?.text ?? '',
        interactivePayload: msg.button?.payload
          ? { type: 'button', id: msg.button.payload, title: msg.button.text }
          : null,
      };
    default:
      // image/audio/document/video/location — por ahora no se procesan
      return null;
  }
}

/**
 * Untrusted helper: extract `phone_number_id` from a raw webhook body BEFORE
 * HMAC validation, only to pick the right app secret. Returns null if the
 * body doesn't have the expected shape. The returned value MUST NOT be used
 * for business logic — only for routing the signature check.
 */
export function extractPhoneNumberIdUntrusted(rawBody: Buffer | string): string | null {
  try {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const parsed = JSON.parse(text) as WhatsAppInboundPayload;
    return parsed.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null;
  } catch {
    return null;
  }
}
