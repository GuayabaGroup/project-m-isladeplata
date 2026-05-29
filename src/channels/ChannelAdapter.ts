import type { Express } from 'express';
import type { ChannelType } from '../core/enums/ChannelType.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Outcome } from '../core/types/Outcome.js';

/**
 * Contract that any inbound channel hands to the pre-graph pipeline.
 * The channel adapter does not know what `process` does — just calls it
 * with a normalized `ChannelMessage` and dispatches the resulting `Outcome`.
 */
export interface MessageProcessor {
  process(message: ChannelMessage): Promise<Outcome>;
}

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
