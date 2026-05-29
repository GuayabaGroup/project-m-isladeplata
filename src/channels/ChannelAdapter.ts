import type { Express } from 'express';
import type { ChannelType } from '../core/enums/ChannelType.js';
import type { MessageProcessor } from '../core/types/MessageProcessor.js';

// `MessageProcessor` vive en `core/` (tipo puro, no depende de Express). Se
// re-exporta acá para no romper los importadores del lado canal.
export type { MessageProcessor } from '../core/types/MessageProcessor.js';

/**
 * Contrato de montaje de un canal de entrada. Cada canal monta SUS rutas
 * (con su propio body-parser — p.ej. `express.raw` para validar el HMAC de
 * WhatsApp) y entrega al pipeline mensajes normalizados vía `processor`.
 *
 * Para sumar un canal (Telegram/web/mobile): crear `channels/{nombre}/`, su
 * normalizer + adapter que implemente esto, y push al array en `bootstrap.ts`.
 * El grafo NO se toca (§12.3 REGLAS).
 */
export interface InboundChannelAdapter {
  readonly channelType: ChannelType;
  register(app: Express, processor: MessageProcessor): void;
}
