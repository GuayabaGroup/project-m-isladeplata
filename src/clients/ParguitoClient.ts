import { type CrmContext, EMPTY_CRM_CONTEXT } from '../core/types/CrmContext.js';
import { BaseHttpClient } from './BaseHttpClient.js';
import type { Envelope } from './types/Envelope.js';

const CRM_CONTEXT_PATH = '/api/v1/crm/context';

/**
 * Parguito — CRM backend. STUB at Etapa 3 (per CLAUDE.md of idp_OV1).
 *
 * **Excepción consciente al patrón general** (§6.3 REGLAS_ISLADEPLATA): los
 * métodos públicos normalmente retornan `T` o lanzan excepción tipada. Aquí,
 * por estar en stub: si Parguito falla o no devuelve datos, este client
 * retorna `EMPTY_CRM_CONTEXT` y loguea `warn`. Razón: en Etapa 3 cualquier
 * 4xx/5xx es esperable; degradar limpio es preferible a propagar.
 *
 * Cuando Parguito salga de stub, replanteamos este comportamiento — quizás
 * mover el fallback al pre-grafo y dejar este client estricto.
 */
export class ParguitoClient extends BaseHttpClient {
  protected readonly errorPrefix = 'parguito';

  /**
   * GET /api/v1/crm/context/{profileUuid} — returns CRM context for a profile.
   * Falls back to `EMPTY_CRM_CONTEXT` on any failure (see class JSDoc).
   */
  async getCrmContext(profileUuid: string): Promise<CrmContext> {
    try {
      const response = await this.http.get<Envelope<CrmContext>>(
        `${CRM_CONTEXT_PATH}/${profileUuid}`,
      );
      return this.unwrap<CrmContext>(response);
    } catch (err) {
      this.logger.warn('Parguito.getCrmContext fell back to defaults', {
        profileUuid,
        error: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_CRM_CONTEXT;
    }
  }
}
