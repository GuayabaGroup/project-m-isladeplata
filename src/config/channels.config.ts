import { z } from 'zod';
import { IdpError } from '../core/errors/IdpError.js';
import { env } from './env.js';

export interface WhatsAppPhoneConfig {
  accessToken: string;
  role: 'staff' | 'client';
  platformId: number;
}

const phoneConfigSchema = z.object({
  access_token: z.string().min(1),
  role: z.enum(['staff', 'client']),
  platform_id: z.number().int().positive(),
});

const channelMapSchema = z.record(z.string(), phoneConfigSchema);
const appSecretMapSchema = z.record(z.string(), z.string().min(1));

function parseChannelMap(): Map<string, WhatsAppPhoneConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.WHATSAPP_CHANNEL_MAP_JSON);
  } catch {
    throw new IdpError('invalid_env', 'WHATSAPP_CHANNEL_MAP_JSON is not valid JSON');
  }
  const validated = channelMapSchema.safeParse(parsed);
  if (!validated.success) {
    throw new IdpError('invalid_env', 'WHATSAPP_CHANNEL_MAP_JSON does not match expected shape', {
      issues: validated.error.flatten(),
    });
  }
  const map = new Map<string, WhatsAppPhoneConfig>();
  for (const [phoneNumberId, cfg] of Object.entries(validated.data)) {
    map.set(phoneNumberId, {
      accessToken: cfg.access_token,
      role: cfg.role,
      platformId: cfg.platform_id,
    });
  }
  return map;
}

function parseAppSecretMap(): Map<number, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.APP_SECRET_BY_PLATFORM_JSON);
  } catch {
    throw new IdpError('invalid_env', 'APP_SECRET_BY_PLATFORM_JSON is not valid JSON');
  }
  const validated = appSecretMapSchema.safeParse(parsed);
  if (!validated.success) {
    throw new IdpError('invalid_env', 'APP_SECRET_BY_PLATFORM_JSON does not match expected shape');
  }
  const map = new Map<number, string>();
  for (const [k, v] of Object.entries(validated.data)) {
    map.set(Number(k), v);
  }
  return map;
}

export const WHATSAPP_CHANNEL_MAP: ReadonlyMap<string, WhatsAppPhoneConfig> = parseChannelMap();
export const APP_SECRET_BY_PLATFORM: ReadonlyMap<number, string> = parseAppSecretMap();

/** Lookup config by inbound `phone_number_id` (the WA number that received the message). */
export function resolveWhatsAppByPhoneNumberId(phoneNumberId: string): WhatsAppPhoneConfig | null {
  return WHATSAPP_CHANNEL_MAP.get(phoneNumberId) ?? null;
}

/** Lookup the app secret for HMAC validation by inbound `phone_number_id`. */
export function resolveAppSecret(phoneNumberId: string): string | null {
  const cfg = resolveWhatsAppByPhoneNumberId(phoneNumberId);
  if (!cfg) return null;
  return APP_SECRET_BY_PLATFORM.get(cfg.platformId) ?? null;
}

/** Reverse lookup: from (role, platformId) → phone_number_id for outbound. */
export function resolveWhatsAppPhoneByRole(
  role: 'staff' | 'client',
  platformId: number,
): string | null {
  for (const [phoneNumberId, cfg] of WHATSAPP_CHANNEL_MAP) {
    if (cfg.role === role && cfg.platformId === platformId) return phoneNumberId;
  }
  return null;
}
