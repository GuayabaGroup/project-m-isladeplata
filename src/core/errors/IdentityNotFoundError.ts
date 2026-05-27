import { IdpError } from './IdpError.js';

/**
 * Raised when Guacuco /identity/resolve returns USER_NOT_FOUND for a client
 * phone (no business linkage). Pre-graph treats this as silent skip —
 * no response, NOT an error to the user.
 */
export class IdentityNotFoundError extends IdpError {
  constructor(message = 'Identity not found', details?: Record<string, unknown>) {
    super('identity_not_found', message, details);
    this.name = 'IdentityNotFoundError';
  }
}
