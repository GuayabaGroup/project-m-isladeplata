export const OUTCOME_ACTIONS = [
  'response',
  'awaiting_user',
  'ignored',
  'rate_limited',
  'error',
  'handed_off',
] as const;
export type OutcomeAction = (typeof OUTCOME_ACTIONS)[number];
