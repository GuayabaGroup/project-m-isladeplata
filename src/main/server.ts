import { env } from '../config/env.js';
import { logger } from '../infrastructure/observability/logger.js';
import { bootstrap } from './bootstrap.js';
import { setupShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const { app, cleanup } = await bootstrap();
  const server = app.listen(env.PORT, () => {
    logger.info('Server listening', { port: env.PORT });
  });
  setupShutdown(server, cleanup);
}

main().catch((err: unknown) => {
  logger.error('Bootstrap failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
