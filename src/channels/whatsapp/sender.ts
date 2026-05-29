import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import { IdpError } from '../../core/errors/IdpError.js';
import type { OutboundHttpClient } from '../../core/types/HttpClient.js';
import type { WhatsAppOutboundMessage } from './types.js';

export interface WhatsAppSendInput {
  phoneNumberId: string;
  accessToken: string;
  message: WhatsAppOutboundMessage;
}

/** Respuesta de Meta Graph API al enviar un mensaje. */
interface WhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
}

/**
 * Sends WhatsApp outbound messages via Meta Graph API.
 *
 * Uses a `RetryClient` built with base URL `https://graph.facebook.com` so
 * the retry policy is shared (5xx + network errors, no 4xx). API version is
 * env-driven (`WHATSAPP_GRAPH_API_VERSION`, default `v22.0`).
 *
 * El `accessToken` se pasa por llamada porque varía por (plataforma, rol).
 * NO se lee de env.
 */
export class WhatsAppSender {
  constructor(
    private readonly http: OutboundHttpClient,
    private readonly logger: Logger,
  ) {}

  /** Envía el mensaje y devuelve el `id` (wamid) que retorna Meta. */
  async send(input: WhatsAppSendInput): Promise<string> {
    const path = `/${env.WHATSAPP_GRAPH_API_VERSION}/${input.phoneNumberId}/messages`;
    try {
      const res = await this.http.post<WhatsAppSendResponse>(path, input.message, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
      });
      const messageId = res.data.messages?.[0]?.id;
      if (!messageId) {
        throw new IdpError(
          'whatsapp_no_message_id',
          'Meta response missing message id',
          undefined,
          {
            upstreamDeliveryFailure: true,
          },
        );
      }
      this.logger.info('WhatsApp message sent', {
        phoneNumberId: input.phoneNumberId,
        to: maskPhone(input.message.to),
        type: input.message.type,
        messageId,
      });
      return messageId;
    } catch (err) {
      // Preservar IdpError (ej. whatsapp_no_message_id) tal cual.
      if (err instanceof IdpError) {
        this.logger.error('Failed to send WhatsApp message', {
          phoneNumberId: input.phoneNumberId,
          to: maskPhone(input.message.to),
          code: err.code,
        });
        throw err;
      }
      // Traducir el error de Meta/axios a IdpError preservando el detalle
      // estructurado (`error` de Meta) sin importar axios acá (§2: axios solo
      // en infrastructure/http). Acceso estructural defensivo.
      const meta = extractMetaError(err);
      this.logger.error('Failed to send WhatsApp message', {
        phoneNumberId: input.phoneNumberId,
        to: maskPhone(input.message.to),
        error: err instanceof Error ? err.message : String(err),
        meta,
      });
      throw new IdpError(
        'whatsapp_send_failed',
        err instanceof Error ? err.message : 'WhatsApp send failed',
        meta !== undefined ? { meta } : undefined,
        { upstreamDeliveryFailure: true },
      );
    }
  }
}

/** Extrae `response.data.error` de un error de axios sin importar el tipo. */
function extractMetaError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  const response = (err as { response?: { data?: { error?: unknown } } }).response;
  return response?.data?.error;
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
