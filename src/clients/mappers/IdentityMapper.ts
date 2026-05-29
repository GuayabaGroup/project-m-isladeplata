import type { IdentityResolveRawResponse, ResolveIdentityOutput } from '../types/GuacucoTypes.js';

/**
 * Maps the raw snake_case payload returned by `GET /api/v1/identity/resolve`
 * to the camelCase `ResolveIdentityOutput` consumed by the pre-graph.
 *
 * Non-throwing: missing/nullable fields are passed through. The pre-graph
 * (`toInternalIdentityOrNull`) is the single place that decides whether the
 * resolved identity has enough to run the graph — see §7.2 REGLAS_ISLADEPLATA.
 */
export function mapRawToResolveIdentityOutput(
  raw: IdentityResolveRawResponse,
): ResolveIdentityOutput {
  return {
    userUuid: raw.user_uuid,
    userName: raw.user_name,
    userPhone: raw.user_phone,
    ...(raw.user_email != null ? { userEmail: raw.user_email } : {}),
    userTimezone: raw.user_timezone,
    userLanguage: raw.user_language,
    profileType: raw.profile_type,
    profileData: raw.profile_data,
    preferences: raw.preferences,
    businessStaffRoles: raw.business_staff_roles,
    helpersLists: raw.helpers_lists ?? [],
    channelData: raw.channel_data,
    isNewUser: raw.is_new_user,
    welcomeMessage: raw.welcome_message ?? null,
    onboardingUrl: raw.onboarding_url ?? null,
    // Solo se incluye cuando Guacuco emite el campo (spec P-human-takeover, hoy
    // bloqueado). Ausente → `humanControlled` queda undefined y el gate se rige
    // solo por el espejo Redis + TTL.
    ...(raw.human_controlled != null
      ? {
          humanControlled: {
            active: raw.human_controlled.active,
            expiresAt: raw.human_controlled.expires_at ?? null,
          },
        }
      : {}),
  };
}
