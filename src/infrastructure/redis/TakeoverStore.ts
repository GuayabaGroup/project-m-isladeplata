import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import type { RedisClient } from './RedisConnection.js';

const ACTIVE_PREFIX = 'takeover:active';
const FAILS_PREFIX = 'takeover:fails';

/**
 * Espejo Redis del estado de takeover humano (spec P-human-takeover) + contador
 * de fallas consecutivas (capa B). Sigue el patrón de `DedupStore`/
 * `RateLimitStore` (§10 REGLAS: TTL siempre explícito, `SET`/`INCR`/`EXPIRE`).
 *
 * Dos llaves por `thread_id`:
 * - `takeover:active:{thread_id}` — presencia = conversación en `human_controlled`.
 *   TTL `TAKEOVER_TTL_SECONDS` = TTL de seguridad de reactivación: si el humano
 *   se olvida de reactivar, el bot vuelve a atender al expirar.
 * - `takeover:fails:{thread_id}` — contador de salidas handed_off/error
 *   consecutivas. `INCR`+`EXPIRE`; se resetea en un outcome exitoso. El TTL es
 *   solo un piso de limpieza (el reset real es por éxito).
 *
 * Guacuco es la fuente de verdad; este espejo es la lectura en caliente del gate
 * del pre-grafo (sin roundtrip HTTP por turno). El campo `humanControlled` de
 * `resolveIdentity` repuebla/invalida el espejo (lo hace el pipeline).
 */
export class TakeoverStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly logger: Logger,
  ) {}

  /** `true` si el thread está actualmente en `human_controlled` (espejo presente). */
  async isHumanControlled(threadId: string): Promise<boolean> {
    const value = await this.redis.get(`${ACTIVE_PREFIX}:${threadId}`);
    return value !== null;
  }

  /**
   * Marca el thread como `human_controlled` en el espejo con TTL de seguridad.
   * Idempotente: re-llamarla mientras está activo solo refresca el TTL.
   */
  async mirrorActive(threadId: string): Promise<void> {
    await this.redis.set(`${ACTIVE_PREFIX}:${threadId}`, '1', {
      EX: env.TAKEOVER_TTL_SECONDS,
    });
    this.logger.debug('Takeover mirror set', { threadId, ttl: env.TAKEOVER_TTL_SECONDS });
  }

  /** Invalida el espejo (reactivación humana detectada vía `resolveIdentity`). */
  async clear(threadId: string): Promise<void> {
    await this.redis.del(`${ACTIVE_PREFIX}:${threadId}`);
    this.logger.debug('Takeover mirror cleared', { threadId });
  }

  /**
   * Incrementa el contador de fallas consecutivas y devuelve el valor nuevo.
   * Setea el TTL solo en el primer incremento (patrón `RateLimitStore`).
   */
  async bumpFailures(threadId: string): Promise<number> {
    const key = `${FAILS_PREFIX}:${threadId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, env.TAKEOVER_TTL_SECONDS);
    }
    return count;
  }

  /** Resetea el contador de fallas (outcome exitoso o post-disparo de capa B). */
  async resetFailures(threadId: string): Promise<void> {
    await this.redis.del(`${FAILS_PREFIX}:${threadId}`);
  }
}
