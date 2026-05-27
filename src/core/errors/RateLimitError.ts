import { IdpError } from './IdpError.js';

export class RateLimitError extends IdpError {
  constructor(message = 'Rate limit exceeded', details?: Record<string, unknown>) {
    super('rate_limit_exceeded', message, details);
    this.name = 'RateLimitError';
  }
}
