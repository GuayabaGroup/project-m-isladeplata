import type { ChannelMessage } from './ChannelMessage.js';
import type { Outcome } from './Outcome.js';

/**
 * Contrato que un canal de entrada entrega al pipeline pre-grafo: recibe un
 * `ChannelMessage` ya normalizado y devuelve el `Outcome` del turno.
 *
 * Vive en `core/` (tipo puro — solo referencia `ChannelMessage` + `Outcome`,
 * ambos de `core/`, NO depende de Express) para que `pregraph/` (que lo
 * implementa) e `infrastructure/http/` (que lo recibe en `RouterDeps`) lo usen
 * sin importar de `channels/` — simétrico a `OutboundChannelAdapter` (§2 / §12.6).
 *
 * El contrato de montaje `InboundChannelAdapter` SÍ depende de Express, por eso
 * sigue en `channels/ChannelAdapter.ts`.
 */
export interface MessageProcessor {
  process(message: ChannelMessage): Promise<Outcome>;
}
