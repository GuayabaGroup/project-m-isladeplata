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

/**
 * Valida invariantes cruzados del routing de canales que el shape Zod por sí solo
 * no cubre (fail-fast al boot, §3 bootstrap / §13.1 REGLAS). Pura y exportada para
 * poder testearla sin tocar `env`:
 *
 *  1. **(role, platformId) único** — el outbound (`resolveWhatsAppPhoneByRole`) hace
 *     first-match; dos phoneNumberIds con el mismo par routearían a uno solo de forma
 *     silenciosa. Un duplicado en el JSON debe romper el boot, no degradar el routing.
 *  2. **Cobertura de app_secret** — todo `platformId` referenciado por el channel map
 *     debe tener su secret en `APP_SECRET_BY_PLATFORM`, o el webhook entrante de esa
 *     plataforma respondería 403 en runtime en vez de fallar al arrancar. Se omite
 *     cuando `skipSignature` (dev: `WHATSAPP_SKIP_SIGNATURE=true` permite operar sin
 *     `APP_SECRET_BY_PLATFORM_JSON`, ver `env.ts`).
 *
 * Lanza `IdpError('invalid_env', ...)` al primer problema (mismo error que el parse).
 */
export function validateChannelConsistency(
  channelMap: ReadonlyMap<string, WhatsAppPhoneConfig>,
  appSecretMap: ReadonlyMap<number, string>,
  skipSignature: boolean,
): void {
  // 1. (role, platformId) único.
  const seenByRolePlatform = new Map<string, string>();
  for (const [phoneNumberId, cfg] of channelMap) {
    const key = `${cfg.role}:${cfg.platformId}`;
    const existing = seenByRolePlatform.get(key);
    if (existing) {
      throw new IdpError(
        'invalid_env',
        `WHATSAPP_CHANNEL_MAP_JSON has duplicate (role, platformId)=(${cfg.role}, ${cfg.platformId}) for phone_number_ids ${existing} and ${phoneNumberId}`,
      );
    }
    seenByRolePlatform.set(key, phoneNumberId);
  }

  // 2. Cobertura de app_secret por plataforma (salvo dev sin firma).
  if (skipSignature) return;
  for (const [phoneNumberId, cfg] of channelMap) {
    if (!appSecretMap.has(cfg.platformId)) {
      throw new IdpError(
        'invalid_env',
        `APP_SECRET_BY_PLATFORM_JSON is missing a secret for platform_id=${cfg.platformId} (referenced by phone_number_id ${phoneNumberId})`,
      );
    }
  }
}

export const WHATSAPP_CHANNEL_MAP: ReadonlyMap<string, WhatsAppPhoneConfig> = parseChannelMap();
export const APP_SECRET_BY_PLATFORM: ReadonlyMap<number, string> = parseAppSecretMap();

validateChannelConsistency(
  WHATSAPP_CHANNEL_MAP,
  APP_SECRET_BY_PLATFORM,
  env.WHATSAPP_SKIP_SIGNATURE,
);

/** Lookup config by inbound `phone_number_id` (the WA number that received the message). */
export function resolveWhatsAppByPhoneNumberId(phoneNumberId: string): WhatsAppPhoneConfig | null {
  return WHATSAPP_CHANNEL_MAP.get(phoneNumberId) ?? null;
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
