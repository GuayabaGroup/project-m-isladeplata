import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../../observability/logger.js';

const API_KEY_HEADER = 'x-api-key';

/**
 * Autentica requests S2S por header `X-API-Key` con comparación de tiempo
 * constante (`timingSafeEqual`) — §13.1. NUNCA comparar con `===` (timing
 * leak). Sin match → 401 sin filtrar detalle del motivo.
 */
export function apiKeyAuth(expectedKey: string): RequestHandler {
  const expected = Buffer.from(expectedKey, 'utf8');
  return (req, res, next) => {
    const provided = req.header(API_KEY_HEADER) ?? '';
    const providedBuf = Buffer.from(provided, 'utf8');
    // timingSafeEqual exige misma longitud; el guard previo evita el throw y
    // mantiene el path constante para longitudes distintas.
    const ok = providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected);
    if (!ok) {
      logger.warn('Rejected request with invalid API key', { path: req.path });
      res
        .status(401)
        .json({ success: false, error: { code: 'unauthorized', message: 'Invalid API key' } });
      return;
    }
    next();
  };
}
