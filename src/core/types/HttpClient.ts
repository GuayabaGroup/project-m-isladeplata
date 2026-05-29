/**
 * Puerto HTTP mínimo y agnóstico de SDK, en `core/` (tipos puros, sin axios).
 *
 * Permite que capas que NO pueden importar `infrastructure/http/` (ej.
 * `channels/`, §2) dependan de un contrato de cliente HTTP en vez del concreto
 * `RetryClient`. El `RetryClient` (infrastructure) implementa estos contratos;
 * el `BaseHttpClient` (clients) consume `HttpResponse` sin ver tipos de axios.
 */

/** Respuesta HTTP genérica — el subconjunto que el código de negocio usa. */
export interface HttpResponse<T> {
  data: T;
  status: number;
}

/** Config opcional por request (hoy solo headers). */
export interface HttpRequestConfig {
  headers?: Record<string, string>;
}

/**
 * Cliente HTTP de salida hacia un proveedor externo (ej. Meta Graph API desde
 * un sender de canal). Solo expone lo que un sender necesita.
 */
export interface OutboundHttpClient {
  post<T>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
}
