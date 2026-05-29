export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'mobile', 'web'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
