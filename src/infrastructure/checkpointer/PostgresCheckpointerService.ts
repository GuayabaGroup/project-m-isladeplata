import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import { IdpError } from '../../core/errors/IdpError.js';

const { Pool } = pg;
type PgPool = pg.Pool;

export interface CheckpointAge {
  exists: boolean;
  ageMs?: number;
}

export interface CheckpointerService {
  /** The LangGraph-compatible checkpointer (pass to `graph.compile({ checkpointer })`). */
  saver: PostgresSaver;
  /** Underlying pg pool, in case a caller needs it (e.g. job to run queries). */
  pool: PgPool;
  /** Returns `{exists, ageMs}` for a thread's most recent checkpoint. */
  getCheckpointAge(threadId: string): Promise<CheckpointAge>;
  /** Delete all checkpoint rows for a thread. Used by ThreadResolver on expiry. */
  deleteThread(threadId: string): Promise<void>;
  /** Periodic cleanup: deletes rows older than TTL. Returns rows deleted. */
  cleanup(): Promise<number>;
  /** Stop cleanup interval + close pg pool. Called from `bootstrap.cleanup`. */
  shutdown(): Promise<void>;
}

/**
 * Build the Postgres-backed checkpointer service for LangGraph.
 *
 * - Fails fast (`IdpError('postgres_connect_failed')`) if Postgres is unreachable.
 * - Runs `saver.setup()` at boot (idempotent migration that creates the
 *   `checkpoints`, `checkpoint_writes`, `checkpoint_blobs` tables).
 * - Starts a periodic cleanup interval (interval from env, default 1h).
 *
 * Postgres del agente — conceptualmente distinto al Postgres del negocio
 * que vive en Guacuco (§5 REGLAS_ISLADEPLATA).
 */
export async function createCheckpointerService(logger: Logger): Promise<CheckpointerService> {
  // The saver maneja su propio pool internamente (vía fromConnString).
  // Mantenemos un pool separado para los queries de TTL/cleanup/delete —
  // dos conexiones pool al mismo Postgres es un costo aceptable y evita
  // el cross-types issue entre @types/pg que vienen de distintas versiones
  // del dependency tree.
  const saver = PostgresSaver.fromConnString(env.POSTGRES_URL);
  await saver.setup();

  const pool = new Pool({ connectionString: env.POSTGRES_URL });

  try {
    const client = await pool.connect();
    client.release();
  } catch (err) {
    await pool.end().catch(() => {});
    throw new IdpError('postgres_connect_failed', 'Could not connect to agent Postgres', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const ttlSeconds = env.CHECKPOINTER_TTL_SECONDS;

  async function getCheckpointAge(threadId: string): Promise<CheckpointAge> {
    // LangGraph's PostgresSaver creates a `checkpoints` table with a
    // `created_at` (or `ts`) column. We query the most-recent row by
    // thread_id. If shape changes in a future lib version, this query
    // is the single place to update.
    const result = await pool.query<{ last_seen: Date | null }>(
      'SELECT MAX(created_at) AS last_seen FROM checkpoints WHERE thread_id = $1',
      [threadId],
    );
    const lastSeen = result.rows[0]?.last_seen ?? null;
    if (!lastSeen) return { exists: false };
    return { exists: true, ageMs: Date.now() - lastSeen.getTime() };
  }

  async function deleteThread(threadId: string): Promise<void> {
    // Borrar las tres tablas del checkpointer en una transacción.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [threadId]);
      await client.query('DELETE FROM checkpoints WHERE thread_id = $1', [threadId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function cleanup(): Promise<number> {
    // INTERVAL syntax usa el valor parametrizado para evitar SQL injection.
    const result = await pool.query(
      "DELETE FROM checkpoints WHERE created_at < NOW() - ($1 || ' seconds')::interval",
      [String(ttlSeconds)],
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info('Checkpointer cleanup deleted rows', { deleted });
    }
    return deleted;
  }

  const cleanupIntervalMs = env.CHECKPOINTER_CLEANUP_INTERVAL_SECONDS * 1000;
  const cleanupInterval = setInterval(() => {
    cleanup().catch((err: unknown) => {
      logger.warn('Checkpointer cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, cleanupIntervalMs);
  // No bloquear el event loop en shutdown si el interval está pendiente.
  cleanupInterval.unref();

  async function shutdown(): Promise<void> {
    clearInterval(cleanupInterval);
    await pool.end();
  }

  logger.info('Postgres checkpointer ready', {
    ttl_seconds: ttlSeconds,
    cleanup_interval_seconds: env.CHECKPOINTER_CLEANUP_INTERVAL_SECONDS,
  });

  return { saver, pool, getCheckpointAge, deleteThread, cleanup, shutdown };
}
