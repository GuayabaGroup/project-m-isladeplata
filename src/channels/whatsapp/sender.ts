import type { Logger } from 'winston';
import { env } from '../../config/env.js';
import type { RetryClient } from '../../infrastructure/http/RetryClient.js';
import type { WhatsAppOutboundMessage } from './types.js';

export interface WhatsAppSendInput {
  phoneNumberId: string;
  accessToken: string;
  message: WhatsAppOutboundMessage;
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
    private readonly http: RetryClient,
    private readonly logger: Logger,
  ) {}

  async send(input: WhatsAppSendInput): Promise<void> {
    const path = `/${env.WHATSAPP_GRAPH_API_VERSION}/${input.phoneNumberId}/messages`;
    try {
      await this.http.post(path, input.message, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
      });
      this.logger.info('WhatsApp message sent', {
        phoneNumberId: input.phoneNumberId,
        to: maskPhone(input.message.to),
        type: input.message.type,
      });
    } catch (err) {
      this.logger.error('Failed to send WhatsApp message', {
        phoneNumberId: input.phoneNumberId,
        to: maskPhone(input.message.to),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
