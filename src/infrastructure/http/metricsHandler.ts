import type { Request, RequestHandler, Response } from 'express';
import type { Registry } from 'prom-client';

const METRICS_HEADER = 'x-metrics-key';

/**
 * Express handler que expone el registro Prometheus. Auth-gated por header
 * `X-Metrics-Key`. Si el `apiKey` configurado es vacío, el bootstrap NO
 * debe montar este handler — por defensa-en-profundidad acá también
 * respondemos 404 si llega request con apiKey vacío.
 *
 * Logging: NO loguear el contenido del header (para no leakear secret a
 * Sentry/winston). Solo loguear el status y la longitud de la respuesta.
 */
export function createMetricsHandler(registry: Registry, apiKey: string): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    if (!apiKey) {
      res.status(404).send('Not found');
      return;
    }
    const provided = req.header(METRICS_HEADER);
    if (!provided || provided !== apiKey) {
      res.status(401).set('WWW-Authenticate', 'X-Metrics-Key').send('Unauthorized');
      return;
    }
    try {
      const body = await registry.metrics();
      res.set('Content-Type', registry.contentType).send(body);
    } catch (_err) {
      res.status(500).send('metrics_collect_failed');
    }
  };
}
