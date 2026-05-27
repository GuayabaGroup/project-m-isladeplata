import type { ChannelType } from '../enums/ChannelType.js';
import type { ProfileType } from '../enums/ProfileType.js';

export interface Identity {
  tenantUuid: string;
  tenantAlliaId: string;
  profileUuid: string;
  profileType: ProfileType;
  platformId: number;
  channel: ChannelType;
  roleId?: number;
  timezone: string;
}
