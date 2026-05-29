import type { Logger } from 'winston';
import { ToolExecutionError } from '../core/errors/ToolExecutionError.js';
import type { HttpResponse } from '../core/types/HttpClient.js';
import type { RetryClient } from '../infrastructure/http/RetryClient.js';
import type { Envelope } from './types/Envelope.js';

/**
 * Abstract base for HTTP clients toward owned backends (Guacuco, Parguito).
 *
 * Encapsulates the envelope unwrap pattern: backends wrap every response in
 * `{success: boolean, data?: T, error?: {...}}`. The single place where this
 * envelope is processed is `unwrap()`, which returns `T` or throws a typed
 * `ToolExecutionError`. Public methods of subclasses NEVER leak the envelope.
 *
 * Subclasses declare `errorPrefix` (e.g. 'guacuco', 'parguito') so the codes
 * emitted by `unwrap` for non-backend errors (invalid envelope, missing data)
 * are namespaced.
 *
 * One of the two canonical exceptions to "composition over inheritance" in
 * Isladeplata — see §6.2 of REGLAS_ISLADEPLATA.
 */
export abstract class BaseHttpClient {
  protected readonly http: RetryClient;
  protected readonly logger: Logger;
  protected abstract readonly errorPrefix: string;

  constructor(http: RetryClient, logger: Logger) {
    this.http = http;
    this.logger = logger;
  }

  /**
   * Process an envelope-wrapped response.
   *
   * Branches:
   * - envelope shape invalid (no `success: boolean`) → `{prefix}_invalid_envelope`
   * - `success: false` → backend's `error.code` (or `{prefix}_unknown_error`)
   * - `success: true` + `data` undefined → `{prefix}_missing_data`
   * - happy path → return `data`
   */
  protected unwrap<T>(response: HttpResponse<Envelope<T>>): T {
    const body = response.data as unknown;

    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { success?: unknown }).success !== 'boolean'
    ) {
      throw new ToolExecutionError(
        `${this.errorPrefix}_invalid_envelope`,
        'Backend response did not match envelope shape',
        { status: response.status },
      );
    }

    const envelope = body as Envelope<T>;

    if (envelope.success === false) {
      const err = envelope.error;
      throw new ToolExecutionError(
        err?.code ?? `${this.errorPrefix}_unknown_error`,
        err?.message ?? 'Backend returned error without message',
        err?.details,
      );
    }

    if (envelope.data === undefined) {
      throw new ToolExecutionError(
        `${this.errorPrefix}_missing_data`,
        'Backend returned success: true with no data',
      );
    }

    return envelope.data;
  }
}
