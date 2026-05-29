import type { ErrorRequestHandler } from 'express';
import { IdpError } from '../../../core/errors/IdpError.js';
import { logger } from '../../observability/logger.js';
import { captureIdpError } from '../../observability/sentry.js';

/**
 * Express error handler. Maps `IdpError` to 400 with `{error, message}`,
 * everything else to 500 with generic message (no stacks to clients).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof IdpError) {
    logger.warn('IdpError caught by middleware', { code: err.code, path: req.path });
    res.status(400).json({ error: err.code, message: err.message });
    return;
  }
  logger.error('Unhandled error in HTTP middleware', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: req.path,
  });
  captureIdpError(err, { component: 'errorHandler', path: req.path });
  res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
};
