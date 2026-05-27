import { timingSafeEqual } from 'node:crypto';
import { validateWhatsAppSignature } from './hmac.js';

/**
 * Centralized webhook signature validation. All inbound webhooks MUST pass
 * through this function — never compare signatures with `===` ad-hoc.
 *
 * Adding a new channel = add a new variant to the discriminated union.
 */
export type WebhookValidationInput =
  | {
      type: 'whatsapp';
      rawBody: Buffer | string;
      signatureHeader: string | undefined;
      appSecret: string;
    }
  | {
      type: 'telegram';
      providedToken: string | undefined;
      expectedToken: string;
    };

export function validateWebhookSignature(input: WebhookValidationInput): boolean {
  switch (input.type) {
    case 'whatsapp':
      return validateWhatsAppSignature(input.rawBody, input.signatureHeader, input.appSecret);
    case 'telegram': {
      if (!input.providedToken || !input.expectedToken) return false;
      if (input.providedToken.length !== input.expectedToken.length) return false;
      return timingSafeEqual(Buffer.from(input.providedToken), Buffer.from(input.expectedToken));
    }
  }
}
