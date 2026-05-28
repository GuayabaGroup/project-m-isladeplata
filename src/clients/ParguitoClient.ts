import type { CrmContext } from '../core/types/CrmContext.js';
import { BaseHttpClient } from './BaseHttpClient.js';
import type { Envelope } from './types/Envelope.js';

const CRM_CONTEXT_PATH = '/api/v1/crm/context';

/**
 * Parguito — CRM backend. Cliente estricto (patrón §6.3 REGLAS_ISLADEPLATA):
 * happy path retorna `CrmContext`, fallos lanzan excepción tipada vía
 * `BaseHttpClient`. La política de "llamar o no llamar" vive en el pre-grafo
 * (`env.PARGUITO_ENABLED`); este client asume que si lo llamás, querés el
 * dato y un fallo es un error real.
 */
export class ParguitoClient extends BaseHttpClient {
  protected readonly errorPrefix = 'parguito';

  /**
   * GET /api/v1/crm/context/{profileUuid} — returns CRM context for a profile.
   * Throws on HTTP error, malformed envelope, or `success=false`.
   */
  async getCrmContext(profileUuid: string): Promise<CrmContext> {
    const response = await this.http.get<Envelope<CrmContext>>(
      `${CRM_CONTEXT_PATH}/${profileUuid}`,
    );
    return this.unwrap<CrmContext>(response);
  }
}
