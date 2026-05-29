import type { RequestHandler } from 'express';
import type { Logger } from 'winston';
import { IdpError } from '../../core/errors/IdpError.js';
import type { OutboundSender } from '../../core/types/OutboundMessage.js';
import { outboundMessageSchema } from './outboundSchema.js';

/** Códigos de `IdpError` que representan un fallo de entrega aguas arriba (→ 502). */
const SEND_FAILURE_CODES = new Set(['whatsapp_send_failed', 'whatsapp_no_message_id']);

/**
 * Handler HTTP de `POST /api/v1/outbound/messages` (ingress S2S de WhatsApp).
 * Vive en `channels/whatsapp` junto al webhook y al schema — co-locación del
 * boundary del canal (§12). Valida el body y delega en `OutboundSender`
 * (interfaz de `core/`, inyectada por `main/`).
 *
 * Emite el envelope estándar de Guacuco `{ success, data }` / `{ success,
 * error }` (paridad §9.1). El detalle de Meta llega vía `IdpError.details`
 * (el `WhatsAppSender` ya tradujo el error de axios) — NO se importa axios acá.
 */
export function createOutboundHttpHandler(sender: OutboundSender, logger: Logger): RequestHandler {
  return async (req, res) => {
    const parsed = outboundMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'invalid_request',
          message: 'Invalid outbound message payload',
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    try {
      const { messageId } = await sender.send(parsed.data);
      res.status(200).json({ success: true, data: { messageId } });
    } catch (err) {
      if (err instanceof IdpError) {
        const status = SEND_FAILURE_CODES.has(err.code) ? 502 : 400;
        logger.warn('Outbound send rejected', { code: err.code, details: err.details });
        res.status(status).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });
        return;
      }
      logger.error('Outbound send failed (unexpected)', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: { code: 'internal_error', message: 'Internal server error' },
      });
    }
  };
}
