export const PROFILE_TYPES = ['client', 'staff'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export function isProfileType(value: unknown): value is ProfileType {
  return typeof value === 'string' && (PROFILE_TYPES as readonly string[]).includes(value);
}
