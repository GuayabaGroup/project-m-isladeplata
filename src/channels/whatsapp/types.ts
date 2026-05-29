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

export type WhatsAppOutboundMessage =
  | WhatsAppOutboundText
  | WhatsAppOutboundInteractiveButtons
  | WhatsAppOutboundInteractiveList
  | WhatsAppOutboundInteractiveCta
  | WhatsAppOutboundTemplate
  | WhatsAppOutboundImage
  | WhatsAppOutboundDocument;

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

/**
 * Mensaje de template (HSM). `components` es opcional — se omite cuando el
 * template no lleva parámetros de body ni botones. Cada botón quick-reply es
 * SU PROPIO componente `{ type:'button', sub_type:'quick_reply', index }` con
 * `index` STRING (Meta lo exige así).
 *
 * Ref: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */
export interface WhatsAppTemplateBodyComponent {
  type: 'body';
  parameters: Array<{ type: 'text'; text: string }>;
}

export interface WhatsAppTemplateButtonComponent {
  type: 'button';
  sub_type: 'quick_reply';
  index: string;
  parameters: Array<{ type: 'payload'; payload: string }>;
}

export type WhatsAppTemplateComponent =
  | WhatsAppTemplateBodyComponent
  | WhatsAppTemplateButtonComponent;

export interface WhatsAppOutboundTemplate extends WhatsAppOutboundBase {
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: WhatsAppTemplateComponent[];
  };
}

export interface WhatsAppOutboundImage extends WhatsAppOutboundBase {
  type: 'image';
  image: { link: string; caption?: string };
}

export interface WhatsAppOutboundDocument extends WhatsAppOutboundBase {
  type: 'document';
  document: { link: string; caption?: string; filename?: string };
}
