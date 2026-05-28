import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import {
  APP_SECRET_BY_PLATFORM,
  resolveWhatsAppByPhoneNumberId,
} from '../../config/channels.config.js';
import { env } from '../../config/env.js';
import { swallowAsync } from '../../infrastructure/observability/swallowAsync.js';
import { validateWebhookSignature } from '../../security/validateWebhookSignature.js';
import type { MessageProcessor } from '../ChannelAdapter.js';
import { extractPhoneNumberIdUntrusted, normalizeWhatsAppPayload } from './normalizer.js';
import type { WhatsAppInboundPayload } from './types.js';

export interface WhatsAppWebhookHandler {
  verify: (req: Request, res: Response) => void;
  handle: (req: Request, res: Response) => void;
}

export interface WhatsAppWebhookDeps {
  processor: MessageProcessor;
  logger: Logger;
}

/**
 * WhatsApp Cloud API webhook (GET verify + POST messages).
 *
 * Flow:
 * 1. Pre-parse raw body untrusted to extract `phone_number_id`.
 * 2. Look up the app secret for that `phone_number_id`.
 * 3. Validate HMAC `X-Hub-Signature-256` over the raw body.
 * 4. Respond `200` IMMEDIATELY (Meta requires <5s).
 * 5. Parse + normalize + hand each message to the processor asynchronously.
 *
 * Errors during step 5 NEVER bubble up — they go to logger + swallowAsync.
 * Pipeline failures responded with 200 (already sent) so Meta does not retry.
 */
export function createWhatsAppWebhookHandler(deps: WhatsAppWebhookDeps): WhatsAppWebhookHandler {
  const { processor, logger } = deps;

  return {
    verify(req, res) {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
        res.status(200).send(typeof challenge === 'string' ? challenge : '');
        return;
      }
      logger.warn('WhatsApp webhook verify failed', { mode });
      res.status(403).end();
    },

    handle(req, res) {
      const rawBody = req.body as Buffer | undefined;
      if (!rawBody || rawBody.length === 0) {
        res.status(200).end();
        return;
      }

      const phoneNumberId = extractPhoneNumberIdUntrusted(rawBody);
      if (!phoneNumberId) {
        // Puede ser un payload de status update u otro field — 200 + ignore.
        res.status(200).end();
        return;
      }

      const phoneCfg = resolveWhatsAppByPhoneNumberId(phoneNumberId);
      if (!phoneCfg) {
        logger.warn('WhatsApp webhook: unknown phone_number_id', { phoneNumberId });
        res.status(403).end();
        return;
      }

      if (env.WHATSAPP_SKIP_SIGNATURE) {
        // Dev-only path — el parse de env ya garantiza que no estamos en prod.
        // Log warn por request para que sea ruidoso e imposible de ignorar.
        logger.warn('WhatsApp webhook: HMAC signature validation SKIPPED (dev only)', {
          phoneNumberId,
        });
      } else {
        const appSecret = APP_SECRET_BY_PLATFORM.get(phoneCfg.platformId);
        if (!appSecret) {
          logger.warn('WhatsApp webhook: no app secret for platform', {
            phoneNumberId,
            platformId: phoneCfg.platformId,
          });
          res.status(403).end();
          return;
        }

        const sigHeader = req.headers['x-hub-signature-256'];
        const signatureHeader = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

        const valid = validateWebhookSignature({
          type: 'whatsapp',
          rawBody,
          signatureHeader,
          appSecret,
        });

        if (!valid) {
          logger.warn('WhatsApp webhook: invalid HMAC signature', { phoneNumberId });
          res.status(403).end();
          return;
        }
      }

      // §12.5 — responder 200 inmediato, procesar async.
      res.status(200).end();

      // Process async (swallowAsync para no romper si el processor lanza).
      swallowAsync(
        logger,
        'WhatsApp webhook async processing failed',
        processInbound(rawBody, phoneNumberId, processor, logger),
        { phoneNumberId },
      );
    },
  };
}

async function processInbound(
  rawBody: Buffer,
  phoneNumberId: string,
  processor: MessageProcessor,
  logger: Logger,
): Promise<void> {
  const phoneCfg = resolveWhatsAppByPhoneNumberId(phoneNumberId);
  if (!phoneCfg) {
    logger.warn('No channel config for phone_number_id', { phoneNumberId });
    return;
  }

  let payload: WhatsAppInboundPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as WhatsAppInboundPayload;
  } catch (err) {
    logger.error('WhatsApp webhook: invalid JSON body after HMAC valid', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const messages = normalizeWhatsAppPayload(payload, phoneCfg.role);
  for (const msg of messages) {
    try {
      await processor.process(msg);
    } catch (err) {
      // catch global del pre-grafo debería atajar todo; este es la última red.
      logger.error('processor.process threw', {
        error: err instanceof Error ? err.message : String(err),
        messageId: msg.messageId,
      });
    }
  }
}
