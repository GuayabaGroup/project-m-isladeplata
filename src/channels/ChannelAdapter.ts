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
