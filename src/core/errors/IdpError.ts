/**
 * Base error for known/expected errors in Isladeplata.
 * - `code` is snake_case (or upstream code when wrapping backend errors).
 * - `details` carries structured context for logging and Sentry.
 *
 * Use `IdpError('invariant_violated', ...)` for internal invariants
 * (preconditions the code guarantees and should never fail at runtime).
 */
export class IdpError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IdpError';
    this.code = code;
    this.details = details;
  }
}
