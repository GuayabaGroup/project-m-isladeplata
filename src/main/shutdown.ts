import type { Server } from 'node:http';
import { logger } from '../infrastructure/observability/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Wire SIGTERM/SIGINT handlers to close the HTTP server and run cleanup.
 *
 * Order: server.close() (stop accepting new conns) → cleanup() (close
 * Sentry, Redis, etc.). A hard timeout forces exit if cleanup hangs.
 *
 * NEVER call `process.exit()` from elsewhere — only here and the env
 * Zod failure in `env.ts`.
 */
export function setupShutdown(server: Server, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = async (signal: string): Promise<void> => {
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
      process.exit(0);
    } catch (err) {
      logger.error('Cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      clearTimeout(timer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void handle('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handle('SIGINT');
  });
}
