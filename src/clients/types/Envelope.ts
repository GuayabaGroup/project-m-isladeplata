/**
 * Envelope shape returned by all owned backends (Guacuco, Parguito).
 *
 * Centralized so `BaseHttpClient.unwrap` is the SINGLE place where the
 * envelope is processed across the whole codebase. Public methods never
 * leak the envelope — they return `T` or throw `ToolExecutionError`.
 */
export interface EnvelopeSuccess<T> {
  success: true;
  data?: T;
}

export interface EnvelopeError {
  success: false;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export type Envelope<T> = EnvelopeSuccess<T> | EnvelopeError;
