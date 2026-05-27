import { IdpError } from './IdpError.js';

/**
 * Raised when Guacuco / Parguito returns `{success: false}` envelope.
 * `code` mirrors the backend error code verbatim (e.g. STAFF_NOT_AVAILABLE,
 * BUSINESS_MISMATCH, IDEMPOTENT_REQUEST_IN_PROGRESS).
 */
export class ToolExecutionError extends IdpError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'ToolExecutionError';
  }
}
