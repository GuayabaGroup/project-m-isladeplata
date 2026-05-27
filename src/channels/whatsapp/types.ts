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
}

// ============================================================================
// Outbound (POST to Meta Graph API)
// ============================================================================

export type WhatsAppOutboundMessage =
  | WhatsAppOutboundText
  | WhatsAppOutboundInteractiveButtons
  | WhatsAppOutboundInteractiveList
  | WhatsAppOutboundInteractiveCta;

export interface WhatsAppOutboundBase {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
}

export interface WhatsAppOutboundText extends WhatsAppOutboundBase {
  type: 'text';
  text: { body: string; preview_url?: boolean };
}

export interface WhatsAppOutboundInteractiveButtons extends WhatsAppOutboundBase {
  type: 'interactive';
  interactive: {
    type: 'button';
    body: { text: string };
    action: {
      buttons: Array<{
        type: 'reply';
        reply: { id: string; title: string };
      }>;
    };
  };
}

export interface WhatsAppOutboundInteractiveList extends WhatsAppOutboundBase {
  type: 'interactive';
  interactive: {
    type: 'list';
    body: { text: string };
    action: {
      button: string;
      sections: Array<{
        rows: Array<{ id: string; title: string; description?: string }>;
      }>;
    };
  };
}

export interface WhatsAppOutboundInteractiveCta extends WhatsAppOutboundBase {
  type: 'interactive';
  interactive: {
    type: 'cta_url';
    body: { text: string };
    action: {
      name: 'cta_url';
      parameters: { display_text: string; url: string };
    };
  };
}
