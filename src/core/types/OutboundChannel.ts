import type { ChannelType } from '../enums/ChannelType.js';
import type { ChannelMessage } from './ChannelMessage.js';
import type { OutboundMessageDto } from './OutboundMessage.js';
import type { OutboundReply } from './Outcome.js';

/**
 * Contrato de SALIDA de un canal — simétrico a `InboundChannelAdapter`
 * (que vive en `channels/` por depender de `Express`). Este contrato solo
 * referencia tipos de `core/`, así que vive acá: `pregraph/` (dispatcher) y
 * `outbound/` (service S2S) lo resuelven por `channelType` sin importar
 * `channels/` y sin `if channelType === 'x'` (§12.3 / §12.6 REGLAS).
 *
 * El adapter encapsula TODO lo específico del canal: formateo con
 * `CHANNEL_FORMATS[channelType]`, resolución de la credencial emisora, y el
 * sender concreto. Es la generalización multicanal del puerto `OutboundSender`.
 *
 * Para sumar un canal: crear `channels/{nombre}/{Nombre}OutboundAdapter.ts`
 * que implemente esto y push al `OutboundChannelRegistry` en `bootstrap.ts`.
 */
export interface OutboundChannelAdapter {
  readonly channelType: ChannelType;

  /**
   * Camino REACTIVO (pre-grafo → usuario). Formatea `reply` para el canal y lo
   * envía al autor de `message`, usando `message.channelMeta` como routing.
   * No-op silencioso (con log) si el reply queda vacío o falta routing meta.
   */
  replyTo(message: ChannelMessage, reply: OutboundReply): Promise<void>;

  /**
   * Camino PROACTIVO (S2S: Guacuco → IDP → usuario). Resuelve la credencial
   * emisora desde el DTO (`role`/`platformId`), formatea y envía. Devuelve el
   * id del mensaje del proveedor. Falla con `IdpError` (nunca `new Error`).
   */
  sendProactive(dto: OutboundMessageDto): Promise<{ messageId: string }>;
}

/**
 * Registro de adapters de salida por canal. Lo arma `bootstrap.ts` (composition
 * root) y lo inyecta en `ResponseDispatcher` y `OutboundMessageService`.
 */
export type OutboundChannelRegistry = ReadonlyMap<ChannelType, OutboundChannelAdapter>;
