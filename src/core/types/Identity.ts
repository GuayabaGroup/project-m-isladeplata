import type { ChannelType } from '../enums/ChannelType.js';
import type { ProfileType } from '../enums/ProfileType.js';

export interface Identity {
  tenantUuid: string;
  tenantAlliaId: string;
  /** Nombre del negocio (`businessStaffRoles.business_name`). Opcional porque el
   * pre-grafo puede no tenerlo en escenarios edge. Lo usa el supervisor para
   * personalizar respuestas sociales. */
  tenantName?: string;
  profileUuid: string;
  profileType: ProfileType;
  platformId: number;
  channel: ChannelType;
  roleId?: number;
  timezone: string;
}
