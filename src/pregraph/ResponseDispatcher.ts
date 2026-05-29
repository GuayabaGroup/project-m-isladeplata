import type { Logger } from 'winston';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { OutboundChannelRegistry } from '../core/types/OutboundChannel.js';
import type { Outcome } from '../core/types/Outcome.js';

/**
 * Routes an `Outcome` to the channel's `OutboundChannelAdapter` (resolved by
 * `channelType` via the registry — NO `if channelType === 'x'`). Skips dispatch
 * for outcomes without `pendingReply` (ignored / handed_off) and for channels
 * with no registered adapter.
 *
 * El formateo + envío vive en el adapter del canal (§12.6 REGLAS). El dispatcher
 * solo resuelve y delega.
 */
export class ResponseDispatcher {
  constructor(
    private readonly registry: OutboundChannelRegistry,
    private readonly logger: Logger,
  ) {}

  async dispatch(message: ChannelMessage, outcome: Outcome): Promise<void> {
    if (!outcome.pendingReply) return;

    const adapter = this.registry.get(message.channelType);
    if (!adapter) {
      this.logger.warn('Dispatch for unsupported channel', { channel: message.channelType });
      return;
    }

    await adapter.replyTo(message, outcome.pendingReply);
  }
}
