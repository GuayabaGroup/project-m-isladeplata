import { describe, expect, it } from 'vitest';
import type { Logger } from 'winston';
import { ResponseBuilder } from '../../../src/nlg/ResponseBuilder.js';

const mockLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;
const builder = new ResponseBuilder(mockLogger);
const TO = '54911000000';

describe('ResponseBuilder.buildForWhatsApp — text', () => {
  it('builds a text message', () => {
    const out = builder.buildForWhatsApp(TO, { text: 'hola' });
    expect(out).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      text: { body: 'hola' },
    });
  });

  it('truncates text past 4096 chars', () => {
    const long = 'a'.repeat(5000);
    const out = builder.buildForWhatsApp(TO, { text: long });
    expect(out?.type).toBe('text');
    if (out?.type === 'text') {
      expect(out.text.body.length).toBe(4096);
      expect(out.text.body.endsWith('…')).toBe(true);
    }
  });

  it('returns null for empty reply', () => {
    expect(builder.buildForWhatsApp(TO, {})).toBeNull();
  });
});

describe('ResponseBuilder.buildForWhatsApp — buttons', () => {
  it('builds interactive buttons', () => {
    const out = builder.buildForWhatsApp(TO, {
      text: '¿Confirmás?',
      buttons: [
        { id: 'confirm:1', title: 'Confirmar' },
        { id: 'cancel:1', title: 'Cancelar' },
      ],
    });
    expect(out?.type).toBe('interactive');
    if (out?.type === 'interactive' && out.interactive.type === 'button') {
      expect(out.interactive.action.buttons).toHaveLength(2);
      expect(out.interactive.action.buttons[0]?.reply).toEqual({
        id: 'confirm:1',
        title: 'Confirmar',
      });
    }
  });

  it('moves overflow buttons to body text when > 3', () => {
    const out = builder.buildForWhatsApp(TO, {
      text: 'Elegí:',
      buttons: [
        { id: 'a', title: 'Opcion 1' },
        { id: 'b', title: 'Opcion 2' },
        { id: 'c', title: 'Opcion 3' },
        { id: 'd', title: 'Opcion 4' },
        { id: 'e', title: 'Opcion 5' },
      ],
    });
    if (out?.type === 'interactive' && out.interactive.type === 'button') {
      expect(out.interactive.action.buttons).toHaveLength(3);
      expect(out.interactive.body.text).toContain('Opcion 4');
      expect(out.interactive.body.text).toContain('Opcion 5');
    }
  });

  it('truncates button titles past 20 chars', () => {
    const out = builder.buildForWhatsApp(TO, {
      text: 't',
      buttons: [{ id: 'x', title: 'a'.repeat(40) }],
    });
    if (out?.type === 'interactive' && out.interactive.type === 'button') {
      const title = out.interactive.action.buttons[0]?.reply.title;
      expect(title?.length).toBe(20);
      expect(title?.endsWith('…')).toBe(true);
    }
  });
});

describe('ResponseBuilder.buildForWhatsApp — list', () => {
  it('builds a list with rows', () => {
    const out = builder.buildForWhatsApp(TO, {
      list: {
        body: 'Elegí horario',
        buttonLabel: 'Ver opciones',
        rows: [
          { id: 'slot:0', title: '4 de marzo - 10:00', description: 'Maria' },
          { id: 'slot:1', title: '4 de marzo - 11:00' },
        ],
      },
    });
    if (out?.type === 'interactive' && out.interactive.type === 'list') {
      expect(out.interactive.action.button).toBe('Ver opciones');
      expect(out.interactive.action.sections[0]?.rows).toHaveLength(2);
      expect(out.interactive.action.sections[0]?.rows[0]?.description).toBe('Maria');
      expect(out.interactive.action.sections[0]?.rows[1]?.description).toBeUndefined();
    }
  });

  it('caps list rows at 10', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    const out = builder.buildForWhatsApp(TO, {
      list: { body: 'b', buttonLabel: 'Ver', rows },
    });
    if (out?.type === 'interactive' && out.interactive.type === 'list') {
      expect(out.interactive.action.sections[0]?.rows).toHaveLength(10);
    }
  });
});

describe('ResponseBuilder.buildForWhatsApp — cta', () => {
  it('builds a cta_url interactive', () => {
    const out = builder.buildForWhatsApp(TO, {
      cta: { text: 'Bienvenido', url: 'https://example.com/onboarding', displayText: 'Comenzar' },
    });
    if (out?.type === 'interactive' && out.interactive.type === 'cta_url') {
      expect(out.interactive.action.parameters).toEqual({
        display_text: 'Comenzar',
        url: 'https://example.com/onboarding',
      });
      expect(out.interactive.body.text).toBe('Bienvenido');
    }
  });
});
