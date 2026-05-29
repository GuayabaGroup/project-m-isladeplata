/** Opciones de construcción de `IdpError`. */
export interface IdpErrorOptions {
  /**
   * `true` = el error representa un fallo de entrega aguas arriba (proveedor de
   * canal — Meta, Telegram, etc.). El ingress S2S lo mapea a HTTP 502 en vez de
   * 400. Channel-agnóstico: reemplaza el viejo set hardcodeado de códigos
   * `whatsapp_*` (§13.2 REGLAS).
   */
  upstreamDeliveryFailure?: boolean;
}

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
  /** Fallo de entrega aguas arriba → HTTP 502 en el ingress S2S. Default `false`. */
  readonly upstreamDeliveryFailure: boolean;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: IdpErrorOptions,
  ) {
    super(message);
    this.name = 'IdpError';
    this.code = code;
    this.details = details;
    this.upstreamDeliveryFailure = options?.upstreamDeliveryFailure ?? false;
  }
}
