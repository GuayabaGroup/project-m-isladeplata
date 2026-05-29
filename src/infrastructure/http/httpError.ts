import { AxiosError } from 'axios';

/**
 * Helpers que encapsulan el conocimiento de `axios` para que las capas que NO
 * deben importar el SDK directo (ej. `clients/`, §6/§11) extraigan status y
 * mensaje de un error HTTP sin tocar `axios`. El único punto donde vive el
 * `instanceof AxiosError` fuera de `RetryClient`.
 */

/** Status HTTP del error si es un error de axios con respuesta; sino undefined. */
export function httpStatusOf(err: unknown): number | undefined {
  return err instanceof AxiosError ? err.response?.status : undefined;
}

/** Mensaje legible del error HTTP (axios o Error genérico). */
export function httpErrorMessage(err: unknown): string | undefined {
  if (err instanceof AxiosError) return err.message;
  return err instanceof Error ? err.message : undefined;
}
