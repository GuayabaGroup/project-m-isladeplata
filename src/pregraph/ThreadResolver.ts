import type { Logger } from 'winston';
import { env } from '../config/env.js';
import type { Identity } from '../core/types/Identity.js';
import type { CheckpointerService } from '../infrastructure/checkpointer/PostgresCheckpointerService.js';

export interface ThreadResolveResult {
  threadId: string;
  /** A previous checkpoint exists and is within TTL. */
  hasActiveCheckpoint: boolean;
  /** A previous checkpoint existed but was past TTL and was deleted in this call. */
  wasExpired: boolean;
}

/**
 * Resolves a thread for the current turn and applies TTL inline:
 *
 * - No prior checkpoint → `hasActiveCheckpoint: false`, `wasExpired: false`
 * - Prior checkpoint within TTL → `hasActiveCheckpoint: true`
 * - Prior checkpoint past TTL → DELETE rows, return `wasExpired: true`
 *
 * Verificación inline al lookup + job periódico de cleanup (§7.3 REGLAS).
 * El thread_id format viene del IDP v2 §10.1 hereda con platformId agregado.
 */
export class ThreadResolver {
  constructor(
    private readonly checkpointer: CheckpointerService,
    private readonly logger: Logger,
  ) {}

  buildThreadId(identity: Identity): string {
    return `${identity.tenantUuid}:${identity.profileUuid}:${identity.channel}:${identity.platformId}`;
  }

  async resolve(identity: Identity): Promise<ThreadResolveResult> {
    const threadId = this.buildThreadId(identity);
    const { exists, ageMs } = await this.checkpointer.getCheckpointAge(threadId);
    if (!exists) {
      return { threadId, hasActiveCheckpoint: false, wasExpired: false };
    }
    const ttlMs = env.CHECKPOINTER_TTL_SECONDS * 1000;
    if ((ageMs ?? 0) > ttlMs) {
      try {
        await this.checkpointer.deleteThread(threadId);
      } catch (err) {
        this.logger.warn('Failed to delete expired thread', {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { threadId, hasActiveCheckpoint: false, wasExpired: true };
    }
    return { threadId, hasActiveCheckpoint: true, wasExpired: false };
  }
}
