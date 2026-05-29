/**
 * Platform ID → nombre de MARCA pública (Allia / Groomia / Divapp).
 *
 * Distinto del nombre del asistente (Ally / Groomy / Divy, ver
 * `personality/assistantName.ts`): acá es la marca de la plataforma, usada en
 * copy hacia el usuario (ej. fallback del welcome flow §7.2 REGLAS cuando
 * Guacuco no envía `welcome_message`). Default `'Allia'` si el `platformId` es
 * desconocido o `null` (mismo criterio que `resolveAssistantName`).
 *
 * Configuración pura (sin deps de infra), consumida por el pre-grafo.
 */

const PLATFORM_BRAND_NAMES: Record<number, string> = {
  1: 'Allia',
  2: 'Groomia',
  3: 'Divapp',
};

export function resolvePlatformBrand(platformId: number | null): string {
  if (platformId == null) return 'Allia';
  return PLATFORM_BRAND_NAMES[platformId] ?? 'Allia';
}
