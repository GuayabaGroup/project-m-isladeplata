import type { ChannelType } from '../enums/ChannelType.js';

export interface InteractivePayload {
  type: 'button' | 'list';
  id: string;
  title?: string;
}

export interface ChannelMessage {
  channelType: ChannelType;
  channelId: string;
  messageId: string;
  contentText: string;
  receivedAt: string;
  whatsappChannel?: 'staff' | 'client';
  phoneNumberId?: string;
  interactivePayload?: InteractivePayload | null;
  userName?: string;
}
