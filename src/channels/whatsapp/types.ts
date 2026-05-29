/**
 * Subset of the WhatsApp Cloud API webhook payload shape needed by the
 * normalizer. Documenta SOLO los campos que el código consume — Meta
 * agrega campos opcionales con frecuencia y queremos tolerar payloads
 * "más grandes" sin romper validación.
 *
 * Ref: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export interface WhatsAppInboundPayload {
  object?: string;
  entry?: WhatsAppInboundEntry[];
}

export interface WhatsAppInboundEntry {
  id?: string;
  changes?: WhatsAppInboundChange[];
}

export interface WhatsAppInboundChange {
  value?: WhatsAppInboundValue;
  field?: string;
}

export interface WhatsAppInboundValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: { name?: string };
    wa_id?: string;
  }>;
  messages?: WhatsAppInboundMessage[];
  statuses?: unknown[];
}

/** Objeto media de Meta Cloud API (image/audio/video/document). */
export interface WhatsAppInboundMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  /** Solo en `document`. */
  filename?: string;
}

export interface WhatsAppInboundMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?:
    | 'text'
    | 'interactive'
    | 'image'
    | 'audio'
    | 'document'
    | 'video'
    | 'button'
    | 'location'
    | string;
  text?: { body?: string };
  interactive?: {
    type?: 'button_reply' | 'list_reply' | string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  button?: { text?: string; payload?: string };
  image?: WhatsAppInboundMedia;
  audio?: WhatsAppInboundMedia;
  video?: WhatsAppInboundMedia;
  document?: WhatsAppInboundMedia;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  /** `context.id` referencia el mensaje citado (p.ej. el template tappeado). */
  context?: { id?: string };
}

// ============================================================================
// Outbound (POST to Meta Graph API)
// ============================================================================
//
// Los tipos OUTBOUND viven en `core/types/WhatsAppOutbound.ts` para que `nlg/`
// los pueda referenciar sin importar de `channels/` (dirección de deps §2).
// Se re-exportan acá para no cambiar los importadores del lado canal
// (sender, OutboundAdapter, bootstrap).
export type * from '../../core/types/WhatsAppOutbound.js';
