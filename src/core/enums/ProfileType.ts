export const PROFILE_TYPES = ['client', 'staff'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];
