import type { RecentTemplate } from '../../core/types/RecentTemplate.js';
import type { RecentTemplateRaw } from '../types/GuacucoTypes.js';

/**
 * Mapea cada entrada raw (snake_case) de `GET /api/v1/template-send-log/recent`
 * al `RecentTemplate` camelCase que consume el pre-grafo/grafo.
 *
 * Extrae `platformId` de `metadata.platform_id` (number o string numérica) para
 * el filtrado cross-platform del pre-grafo. No-throwing: campos ausentes pasan
 * como `null`.
 */
export function mapRawToRecentTemplate(raw: RecentTemplateRaw): RecentTemplate {
  return {
    templateName: raw.template_name,
    userType: raw.user_type,
    langCode: raw.lang_code,
    parameters: Array.isArray(raw.parameters) ? raw.parameters : [],
    channelPhoneNumberId: raw.channel_phone_number_id,
    metaMessageId: raw.meta_message_id,
    status: raw.status,
    sourceComponent: raw.source_component,
    platformId: extractPlatformId(raw.metadata),
    createdAt: raw.created_at,
  };
}

function extractPlatformId(metadata: Record<string, unknown> | null): number | null {
  if (!metadata) return null;
  const value = metadata.platform_id;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}
