import type { ChannelType } from '../enums/ChannelType.js';
import type { OutboundButton, OutboundCta, OutboundList } from './Outcome.js';

/**
 * Provider-agnostic outbound message contract. Es el shape canónico que viaja
 * desde el endpoint S2S `POST /api/v1/outbound/messages` (Guacuco → IDP) hasta
 * el builder de canal. NO conoce Meta/WhatsApp — el mapeo a payload concreto
 * vive en `nlg/OutboundMessageBuilder`.
 *
 * `core/` no depende de nada (§2): reusa los tipos interactivos de `Outcome.ts`.
 */

/**
 * Base del contrato S2S agnóstico. `channelType` selecciona el
 * `OutboundChannelAdapter` emisor; `(role, platformId)` resuelven la credencial
 * emisora dentro del canal (en WhatsApp: el `phone_number_id`). `role` y
 * `platformId` son ejes de producto cross-channel (no WhatsApp-only).
 */
export interface OutboundMessageBase {
  channelType: ChannelType;
  to: string;
  role: 'staff' | 'client';
  platformId: number;
  /** Si presente, dedup por `SET NX` evita doble envío dentro del TTL. */
  idempotencyKey?: string;
}

export interface OutboundTextDto extends OutboundMessageBase {
  type: 'text';
  text: { body: string; previewUrl?: boolean };
}

/** Parámetro de body de un template (formato Meta `{ type:'text', text }`). */
export interface OutboundTemplateParameter {
  type: 'text';
  text: string;
}

/** Botón quick-reply de un template: `index` posicional + `payload` de retorno. */
export interface OutboundTemplateButton {
  index: number;
  payload: string;
}

export interface OutboundTemplateDto extends OutboundMessageBase {
  type: 'template';
  template: {
    name: string;
    langCode: string;
    parameters: OutboundTemplateParameter[];
    buttons?: OutboundTemplateButton[];
  };
}

export type OutboundInteractive =
  | { kind: 'buttons'; body: string; buttons: OutboundButton[] }
  | { kind: 'list'; list: OutboundList }
  | { kind: 'cta'; cta: OutboundCta };

export interface OutboundInteractiveDto extends OutboundMessageBase {
  type: 'interactive';
  interactive: OutboundInteractive;
}

export interface OutboundMediaDto extends OutboundMessageBase {
  type: 'media';
  media: {
    kind: 'image' | 'document';
    link: string;
    caption?: string;
    /** Solo aplica a `document`; ignorado para `image`. */
    filename?: string;
  };
}

export type OutboundMessageDto =
  | OutboundTextDto
  | OutboundTemplateDto
  | OutboundInteractiveDto
  | OutboundMediaDto;

/**
 * Puerto de envío proactivo. El handler HTTP (capa `infrastructure/`) depende
 * de esta interfaz de `core/` —nunca de `outbound/` directo— para respetar la
 * dirección de dependencias (§2). La impl concreta es `OutboundMessageService`.
 */
export interface OutboundSender {
  send(dto: OutboundMessageDto): Promise<{ messageId: string }>;
}
