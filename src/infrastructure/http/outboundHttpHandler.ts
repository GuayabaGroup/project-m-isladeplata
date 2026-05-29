import type { RequestHandler } from 'express';
import type { Logger } from 'winston';
import { IdpError } from '../../core/errors/IdpError.js';
import type { OutboundSender } from '../../core/types/OutboundMessage.js';
import { outboundMessageSchema } from './outboundSchema.js';

/**
 * Handler HTTP de `POST /api/v1/outbound/messages` (ingress S2S agnóstico de
 * canal). Vive en `infrastructure/http/` junto al resto del plumbing HTTP: solo
 * depende de `core/` (`OutboundSender`, `IdpError`) + el schema zod, nunca de un
 * canal concreto. Valida el body y delega en `OutboundSender` (interfaz de
 * `core/`, inyectada por `main/`).
 *
 * Emite el envelope estándar de Guacuco `{ success, data }` / `{ success,
 * error }` (paridad §9.1). Mapea a 502 los fallos de entrega aguas arriba vía
 * `IdpError.upstreamDeliveryFailure` (channel-agnóstico — §13.2 REGLAS); el
 * resto de los `IdpError` van a 400. El detalle del proveedor llega vía
 * `IdpError.details` (el sender ya tradujo el error).
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
        const status = err.upstreamDeliveryFailure ? 502 : 400;
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
