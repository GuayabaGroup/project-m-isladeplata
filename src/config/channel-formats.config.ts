import type { ChannelType } from '../core/enums/ChannelType.js';

export interface ChannelFormatLimits {
  textMax: number;
  bodyMax: number;
  buttonsMax: number;
  buttonTitleMax: number;
  listRowsMax: number;
  listRowTitleMax: number;
  listRowDescriptionMax: number;
  ctaDisplayTextMax: number;
}

/**
 * Per-channel format limits. SINGLE source of truth — `ResponseBuilder` y
 * senders SIEMPRE leen de aquí, NUNCA hardcodear (§12.4 REGLAS_ISLADEPLATA).
 *
 * WhatsApp: Cloud API limits.
 * Telegram: Bot API (más laxos, sin button cap).
 * Mobile: cliente nativo renderiza — sin truncación en server-side.
 */
export const CHANNEL_FORMATS: Record<ChannelType, ChannelFormatLimits> = {
  whatsapp: {
    textMax: 4096,
    bodyMax: 1024,
    buttonsMax: 3,
    buttonTitleMax: 20,
    listRowsMax: 10,
    listRowTitleMax: 24,
    listRowDescriptionMax: 72,
    ctaDisplayTextMax: 20,
  },
  telegram: {
    textMax: 4096,
    bodyMax: 4096,
    buttonsMax: Number.POSITIVE_INFINITY,
    buttonTitleMax: 64,
    listRowsMax: 10,
    listRowTitleMax: 64,
    listRowDescriptionMax: 64,
    ctaDisplayTextMax: 64,
  },
  mobile: {
    textMax: Number.POSITIVE_INFINITY,
    bodyMax: Number.POSITIVE_INFINITY,
    buttonsMax: Number.POSITIVE_INFINITY,
    buttonTitleMax: Number.POSITIVE_INFINITY,
    listRowsMax: Number.POSITIVE_INFINITY,
    listRowTitleMax: Number.POSITIVE_INFINITY,
    listRowDescriptionMax: Number.POSITIVE_INFINITY,
    ctaDisplayTextMax: Number.POSITIVE_INFINITY,
  },
  web: {
    textMax: Number.POSITIVE_INFINITY,
    bodyMax: Number.POSITIVE_INFINITY,
    buttonsMax: Number.POSITIVE_INFINITY,
    buttonTitleMax: Number.POSITIVE_INFINITY,
    listRowsMax: Number.POSITIVE_INFINITY,
    listRowTitleMax: Number.POSITIVE_INFINITY,
    listRowDescriptionMax: Number.POSITIVE_INFINITY,
    ctaDisplayTextMax: Number.POSITIVE_INFINITY,
  },
};

/** Truncate to max-1 chars + ellipsis. Pass-through when max is Infinity. */
export function truncate(text: string, max: number): string {
  if (!Number.isFinite(max) || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
