import type { Server } from 'node:http';
import { logger } from '../infrastructure/observability/logger.js';
import { captureIdpError } from '../infrastructure/observability/sentry.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Wire SIGTERM/SIGINT + process-level error handlers to close the HTTP
 * server and run cleanup.
 *
 * Order: server.close() (stop accepting new conns) → cleanup() (close
 * Sentry, Redis, etc.). A hard timeout forces exit if cleanup hangs.
 *
 * NEVER call `process.exit()` from elsewhere — only here and the env
 * Zod failure in `env.ts`. The `uncaughtException` handler routes through
 * this same graceful path (never a raw `exit`).
 */
export function setupShutdown(server: Server, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutdown signal received', { signal });

    const timer = setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await cleanup();
      clearTimeout(timer);
      process.exit(exitCode);
    } catch (err) {
      logger.error('Cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(timer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void handle('SIGTERM', 0);
  });
  process.on('SIGINT', () => {
    void handle('SIGINT', 0);
  });

  // uncaughtException: el proceso queda en estado indefinido. Capturamos a
  // Sentry y disparamos el MISMO shutdown graceful (cleanup → closeSentry hace
  // flush) con exit(1) para que el orquestador reinicie. No `process.exit`
  // crudo acá: el exit sigue viviendo solo en `handle`.
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — triggering graceful shutdown', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    captureIdpError(err, { component: 'process.uncaughtException' });
    void handle('uncaughtException', 1);
  });

  // unhandledRejection: bug que se escapó del catch por-turno del pipeline.
  // Log + Sentry para observabilidad, pero NO tiramos el proceso: aislamos el
  // fallo y no matamos conversaciones en vuelo de otros usuarios. Sentry envía
  // en background (no exit → no hace falta flush).
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    captureIdpError(reason, { component: 'process.unhandledRejection' });
  });
}
