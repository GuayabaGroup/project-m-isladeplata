/**
 * Smoke test contra Guacuco real. Resuelve identity de un número de prueba.
 *
 * Uso:
 *   tsx scripts/smoke-guacuco.ts <channelId> [phoneNumberId]
 *
 * Vars env requeridas: GUACUCO_URL, GUACUCO_API_KEY (en .env o exportadas).
 *
 * Validador del DoD de H1. NO se ejecuta en CI — se corre localmente contra
 * Guacuco staging cuando se quiere validar el cliente end-to-end.
 */
import { GuacucoClient } from '../src/clients/GuacucoClient.js';
import { env } from '../src/config/env.js';
import { RetryClient } from '../src/infrastructure/http/RetryClient.js';
import { logger } from '../src/infrastructure/observability/logger.js';

async function main(): Promise<void> {
  const [, , channelIdArg, phoneNumberIdArg] = process.argv;
  if (!channelIdArg) {
    logger.error('Usage: tsx scripts/smoke-guacuco.ts <channelId> [phoneNumberId]');
    process.exit(1);
  }

  const http = new RetryClient({
    baseURL: env.GUACUCO_URL,
    timeoutMs: env.GUACUCO_TIMEOUT_MS,
    headers: { 'X-API-Key': env.GUACUCO_API_KEY },
    logger,
  });

  const client = new GuacucoClient(http, logger);

  logger.info('Resolving identity', {
    url: env.GUACUCO_URL,
    channelId: `${channelIdArg.slice(0, 4)}***`,
  });

  try {
    const identity = await client.resolveIdentity({
      channelType: 'whatsapp',
      channelId: channelIdArg,
      phoneNumberId: phoneNumberIdArg,
    });

    logger.info('Identity resolved', {
      userUuid: identity.userUuid,
      profileType: identity.profileType,
      isNewUser: identity.isNewUser,
      businessName: identity.businessStaffRoles?.business_name ?? null,
      businessAlliaId: identity.businessStaffRoles?.business_allia_id ?? null,
      platformId: identity.businessStaffRoles?.platform_id ?? null,
      servicesCount: identity.helpersLists[0]?.service_uuids.items.length ?? 0,
    });
  } catch (err) {
    logger.error('Smoke test failed', {
      error: err instanceof Error ? err.message : String(err),
      code: err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : null,
    });
    process.exit(2);
  }
}

void main();
