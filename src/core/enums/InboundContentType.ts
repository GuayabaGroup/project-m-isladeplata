export const INBOUND_CONTENT_TYPES = [
  'text',
  'interactive',
  'template_button',
  'image',
  'audio',
  'video',
  'document',
  'location',
] as const;
export type InboundContentType = (typeof INBOUND_CONTENT_TYPES)[number];
