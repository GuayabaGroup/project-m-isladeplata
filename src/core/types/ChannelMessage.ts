import type { ChannelType } from '../enums/ChannelType.js';
import type { InboundContentType } from '../enums/InboundContentType.js';

export interface InteractivePayload {
  type: 'button' | 'list';
  id: string;
  title?: string;
}

/**
 * Media adjunta entrante. Se TRANSPORTA, no se resuelve: en WhatsApp solo
 * llega un `id` (descargar los bytes vía Graph API queda fuera de alcance).
 */
export interface InboundMedia {
  id: string;
  mimeType?: string;
  caption?: string;
  filename?: string;
  sha256?: string;
}

export interface InboundLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/**
 * Tap sobre un botón quick-reply de un template (Meta `type: 'button'`).
 * `contextMessageId` = `context.id` del template original (para correlacionar
 * qué template se respondió). `payload` = el payload dinámico que volvió.
 */
export interface TemplateButtonPayload {
  contextMessageId?: string;
  payload?: string;
}

/**
 * Routing/credentials meta OPACO del canal de origen. Cada canal define qué
 * claves usa; el pre-grafo NO las interpreta — solo las transporta (p.ej. al
 * identity resolve) y el `OutboundChannelAdapter` del canal las lee para el
 * camino reactivo. WhatsApp usa `phoneNumberId` (selección del token emisor) y
 * `role` (`'staff' | 'client'`). Mantener `core/` agnóstico: NO tipar claves
 * por canal acá.
 */
export type ChannelMeta = Readonly<Record<string, string>>;

export interface ChannelMessage {
  channelType: ChannelType;
  channelId: string;
  messageId: string;
  /** Discriminador del tipo de contenido entrante (lo setea el normalizer en toda rama). */
  contentType: InboundContentType;
  /** Texto humano canónico para TODO tipo (caption para media, name/address para location). */
  contentText: string;
  receivedAt: string;
  /** Meta de routing específico del canal (opaco para el pre-grafo). Ver `ChannelMeta`. */
  channelMeta?: ChannelMeta;
  interactivePayload?: InteractivePayload | null;
  /**
   * Set para `template_button`. Solapa a propósito con `interactivePayload`
   * (que sigue siendo el carrier de routing para buttonShortcut/resume).
   */
  templateButton?: TemplateButtonPayload;
  /** Set para image/audio/video/document. */
  media?: InboundMedia;
  /** Set para location. */
  location?: InboundLocation;
  userName?: string;
}
