import { describe, expect, it } from 'vitest';
import { outboundMessageSchema } from '../../../../src/channels/whatsapp/outboundSchema.js';

describe('outboundMessageSchema', () => {
  it('transforms snake_case text payload to a camelCase DTO', () => {
    const parsed = outboundMessageSchema.parse({
      to: '549111',
      role: 'client',
      platform_id: 1,
      type: 'text',
      text: { body: 'hola', preview_url: true },
      idempotency_key: 'k1',
    });
    expect(parsed).toEqual({
      to: '549111',
      role: 'client',
      platformId: 1,
      idempotencyKey: 'k1',
      type: 'text',
      text: { body: 'hola', previewUrl: true },
    });
  });

  it('collapses user_type "owner" to role "staff"', () => {
    const parsed = outboundMessageSchema.parse({
      to: '549111',
      user_type: 'owner',
      platform_id: 2,
      type: 'text',
      text: { body: 'x' },
    });
    expect(parsed.role).toBe('staff');
  });

  it('maps user_type "client" to role "client"', () => {
    const parsed = outboundMessageSchema.parse({
      to: '549111',
      user_type: 'client',
      platform_id: 1,
      type: 'text',
      text: { body: 'x' },
    });
    expect(parsed.role).toBe('client');
  });

  it('rejects payloads with neither role nor user_type', () => {
    const result = outboundMessageSchema.safeParse({
      to: '549111',
      platform_id: 1,
      type: 'text',
      text: { body: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('parses a template with lang_code and quick-reply buttons', () => {
    const parsed = outboundMessageSchema.parse({
      to: '549111',
      user_type: 'staff',
      platform_id: 1,
      type: 'template',
      template: {
        name: 'p2_confirm',
        lang_code: 'es',
        parameters: [{ type: 'text', text: 'Juan' }],
        buttons: [{ index: 0, payload: 'confirmar:abc' }],
      },
    });
    expect(parsed.type).toBe('template');
    if (parsed.type === 'template') {
      expect(parsed.template.langCode).toBe('es');
      expect(parsed.template.buttons).toEqual([{ index: 0, payload: 'confirmar:abc' }]);
    }
  });

  it('defaults template parameters to an empty array', () => {
    const parsed = outboundMessageSchema.parse({
      to: '549111',
      role: 'staff',
      platform_id: 1,
      type: 'template',
      template: { name: 't', lang_code: 'es' },
    });
    if (parsed.type === 'template') {
      expect(parsed.template.parameters).toEqual([]);
    }
  });
});
