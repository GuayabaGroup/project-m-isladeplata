/**
 * Tipos del payload OUTBOUND de WhatsApp Cloud API (POST a Meta Graph API).
 *
 * Viven en `core/` (tipos puros, sin deps) para que tanto `nlg/` (que formatea
 * vía `ResponseBuilder.buildForWhatsApp` — §12.4) como `channels/whatsapp/`
 * (que envía) puedan referenciarlos sin que `nlg/` importe de `channels/`
 * (lo cual violaría la dirección de dependencias §2).
 *
 * El payload INBOUND (webhook) sigue en `channels/whatsapp/types.ts`: solo lo
 * consume el normalizer del canal.
 *
 * Ref: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 */

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
