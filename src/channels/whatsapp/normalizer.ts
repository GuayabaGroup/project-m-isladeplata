import type { ChannelMessage, InboundMedia } from '../../core/types/ChannelMessage.js';
import type {
  WhatsAppInboundMedia,
  WhatsAppInboundMessage,
  WhatsAppInboundPayload,
} from './types.js';

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
        contentType: 'text',
        contentText: msg.text?.body ?? '',
        interactivePayload: null,
      };
    case 'interactive': {
      const inter = msg.interactive;
      if (inter?.type === 'button_reply' && inter.button_reply?.id) {
        return {
          ...base,
          contentType: 'interactive',
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
          contentType: 'interactive',
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
      // Razón: el tap de un quick-reply de template se modela como
      // `template_button` (con contextMessageId del template citado), pero se
      // SIGUE poblando `interactivePayload` porque es el carrier de routing de
      // `detectButtonShortcut` (compile.ts) y del resume (pipeline.ts). El
      // solapamiento del payload es deliberado.
      return {
        ...base,
        contentType: 'template_button',
        contentText: msg.button?.text ?? '',
        templateButton: {
          contextMessageId: msg.context?.id,
          payload: msg.button?.payload,
        },
        interactivePayload: msg.button?.payload
          ? { type: 'button', id: msg.button.payload, title: msg.button.text }
          : null,
      };
    case 'image':
      return {
        ...base,
        contentType: 'image',
        contentText: msg.image?.caption ?? '',
        media: mapMedia(msg.image),
      };
    case 'audio':
      // audio no tiene caption en Meta → contentText vacío.
      return { ...base, contentType: 'audio', contentText: '', media: mapMedia(msg.audio) };
    case 'video':
      return {
        ...base,
        contentType: 'video',
        contentText: msg.video?.caption ?? '',
        media: mapMedia(msg.video),
      };
    case 'document':
      return {
        ...base,
        contentType: 'document',
        contentText: msg.document?.caption ?? '',
        media: mapMedia(msg.document),
      };
    case 'location': {
      const loc = msg.location;
      if (loc?.latitude === undefined || loc.longitude === undefined) return null;
      return {
        ...base,
        contentType: 'location',
        contentText: loc.name ?? loc.address ?? '',
        location: {
          latitude: loc.latitude,
          longitude: loc.longitude,
          ...(loc.name ? { name: loc.name } : {}),
          ...(loc.address ? { address: loc.address } : {}),
        },
      };
    }
    default:
      // statuses/reactions/sticker/unknown — no se procesan.
      return null;
  }
}

/** Mapea un media object de Meta a `InboundMedia`. `undefined` si no hay id. */
function mapMedia(m: WhatsAppInboundMedia | undefined): InboundMedia | undefined {
  if (!m?.id) return undefined;
  return {
    id: m.id,
    ...(m.mime_type ? { mimeType: m.mime_type } : {}),
    ...(m.caption ? { caption: m.caption } : {}),
    ...(m.filename ? { filename: m.filename } : {}),
    ...(m.sha256 ? { sha256: m.sha256 } : {}),
  };
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
