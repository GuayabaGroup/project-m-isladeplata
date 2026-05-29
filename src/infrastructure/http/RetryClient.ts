import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import type { Logger } from 'winston';
import type { OutboundHttpClient } from '../../core/types/HttpClient.js';

const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface RetryClientOptions {
  baseURL: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  logger: Logger;
}

/**
 * Thin wrapper around axios with retry-with-jitter for transient failures
 * (5xx in {502, 503, 504} and network errors without response). NEVER
 * retries 4xx (including 404 and 401). Backoff capped at 2000ms.
 *
 * All HTTP clients toward owned backends (Guacuco, Parguito) must use this
 * via `BaseHttpClient` — see §6 REGLAS_ISLADEPLATA.
 *
 * Implementa `OutboundHttpClient` (puerto `core/`) para que capas que no pueden
 * importar `infrastructure/http/` (ej. `channels/`) dependan del contrato, no
 * del concreto. `AxiosResponse<T>` es estructuralmente compatible con
 * `HttpResponse<T>`.
 */
export class RetryClient implements OutboundHttpClient {
  private readonly axios: AxiosInstance;
  private readonly logger: Logger;

  constructor(opts: RetryClientOptions) {
    this.axios = axios.create({
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      headers: opts.headers,
    });
    this.logger = opts.logger;
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.axios.get<T>(url, config), `GET ${url}`);
  }

  async post<T>(
    url: string,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.axios.post<T>(url, body, config), `POST ${url}`);
  }

  async patch<T>(
    url: string,
    body?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.axios.patch<T>(url, body, config), `PATCH ${url}`);
  }

  private async withRetry<T>(
    fn: () => Promise<AxiosResponse<T>>,
    label: string,
  ): Promise<AxiosResponse<T>> {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= MAX_RETRIES) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!this.shouldRetry(err) || attempt === MAX_RETRIES) {
          throw err;
        }
        const delay = this.backoff(attempt);
        this.logger.warn('http retry', { label, attempt: attempt + 1, delay_ms: delay });
        await sleep(delay);
        attempt += 1;
      }
    }
    throw lastErr;
  }

  private shouldRetry(err: unknown): boolean {
    if (!(err instanceof AxiosError)) return false;
    if (!err.response) return true;
    return RETRYABLE_STATUS.has(err.response.status);
  }

  private backoff(attempt: number): number {
    const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * base * 0.3;
    return Math.floor(base + jitter);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
