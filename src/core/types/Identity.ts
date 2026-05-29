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
  /** Nombre personalizado del asistente para este tenant
   * (`businessStaffRoles.agent_name`). Opcional: si es `null`/ausente se usa
   * el nombre por defecto de la plataforma (Ally/Groomy/Divy). Lo consume la
   * capa de personalidad (`config/personality`) para resolver el nombre del
   * asistente en las respuestas al usuario. */
  agentName?: string | null;
  /** Código ISO alpha-3 del país del negocio
   * (`businessStaffRoles.business_country_code`). Opcional. Determina el
   * acento/dialecto del español en las respuestas (voseo/tuteo, vocabulario
   * regional). `null`/ausente → español latinoamericano neutro. */
  countryCode?: string | null;
}
