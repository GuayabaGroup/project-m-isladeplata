export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'mobile', 'web'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as readonly string[]).includes(value);
}
