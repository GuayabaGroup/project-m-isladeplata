import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateWhatsAppSignature } from '../../../src/security/hmac.js';
import { validateWebhookSignature } from '../../../src/security/validateWebhookSignature.js';

const SECRET = 'super_secret_app_secret';
const BODY = JSON.stringify({ test: 'payload' });

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('validateWhatsAppSignature', () => {
  it('accepts a valid signature', () => {
    const sig = sign(BODY, SECRET);
    expect(validateWhatsAppSignature(BODY, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(BODY, SECRET);
    expect(validateWhatsAppSignature(`${BODY}X`, sig, SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = sign(BODY, SECRET);
    expect(validateWhatsAppSignature(BODY, sig, 'wrong_secret')).toBe(false);
  });

  it('rejects missing signature header', () => {
    expect(validateWhatsAppSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it('rejects non-sha256 scheme', () => {
    expect(validateWhatsAppSignature(BODY, 'sha1=abcdef', SECRET)).toBe(false);
  });

  it('rejects empty appSecret', () => {
    const sig = sign(BODY, SECRET);
    expect(validateWhatsAppSignature(BODY, sig, '')).toBe(false);
  });

  it('rejects signature with different length', () => {
    expect(validateWhatsAppSignature(BODY, 'sha256=short', SECRET)).toBe(false);
  });
});

describe('validateWebhookSignature', () => {
  it('routes whatsapp variant correctly', () => {
    const sig = sign(BODY, SECRET);
    expect(
      validateWebhookSignature({
        type: 'whatsapp',
        rawBody: BODY,
        signatureHeader: sig,
        appSecret: SECRET,
      }),
    ).toBe(true);
  });

  it('routes telegram variant correctly', () => {
    expect(
      validateWebhookSignature({
        type: 'telegram',
        providedToken: 'tok-123',
        expectedToken: 'tok-123',
      }),
    ).toBe(true);
  });

  it('rejects mismatching telegram token', () => {
    expect(
      validateWebhookSignature({
        type: 'telegram',
        providedToken: 'tok-123',
        expectedToken: 'tok-456',
      }),
    ).toBe(false);
  });

  it('rejects empty telegram tokens', () => {
    expect(
      validateWebhookSignature({
        type: 'telegram',
        providedToken: undefined,
        expectedToken: 'tok-123',
      }),
    ).toBe(false);
  });
});
