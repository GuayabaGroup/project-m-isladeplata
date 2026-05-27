import type { Logger } from 'winston';

/**
 * Fire-and-forget wrapper for non-critical async operations (signals,
 * persistence, trace saves, lock releases). Logs `warn` on failure with
 * structured context. NEVER throws.
 *
 * If you find yourself wanting an `error` log level here, the operation is
 * not truly fire-and-forget — use `await` + explicit try/catch in the caller.
 */
export async function swallowAsync(
  logger: Logger,
  label: string,
  promise: Promise<unknown>,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    logger.warn(label, {
      error: err instanceof Error ? err.message : String(err),
      ...context,
    });
  }
}
