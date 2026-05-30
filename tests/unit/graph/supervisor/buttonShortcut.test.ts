import { describe, expect, it } from 'vitest';
import {
  detectButtonShortcut,
  detectTemplateButtonShortcut,
} from '../../../../src/graph/supervisor/buttonShortcut.js';

describe('detectButtonShortcut', () => {
  it('detects confirm:<uuid>', () => {
    const out = detectButtonShortcut({ type: 'button', id: 'confirm:abc-123' });
    expect(out).toEqual({ kind: 'confirm', value: 'abc-123' });
  });

  it('detects cancel:<uuid>', () => {
    const out = detectButtonShortcut({ type: 'button', id: 'cancel:xyz-9' });
    expect(out).toEqual({ kind: 'cancel', value: 'xyz-9' });
  });

  it('detects slot_pick:<index> as number', () => {
    const out = detectButtonShortcut({ type: 'list', id: 'slot_pick:2' });
    expect(out).toEqual({ kind: 'slot_pick', value: 2 });
  });

  it('detects service:<uuid>', () => {
    const out = detectButtonShortcut({ type: 'list', id: 'service:svc-1' });
    expect(out).toEqual({ kind: 'service_pick', value: 'svc-1' });
  });

  it('detects staff:<uuid>', () => {
    const out = detectButtonShortcut({ type: 'list', id: 'staff:stf-1' });
    expect(out).toEqual({ kind: 'staff_pick', value: 'stf-1' });
  });

  it('returns null for free text (no payload)', () => {
    expect(detectButtonShortcut(null)).toBeNull();
    expect(detectButtonShortcut(undefined)).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(detectButtonShortcut({ type: 'button', id: 'random:abc' })).toBeNull();
  });

  it('returns null for prefix with empty payload', () => {
    expect(detectButtonShortcut({ type: 'button', id: 'confirm:' })).toBeNull();
  });

  it('returns null for slot_pick with non-numeric index', () => {
    expect(detectButtonShortcut({ type: 'list', id: 'slot_pick:abc' })).toBeNull();
  });

  it('returns null for slot_pick with negative index', () => {
    expect(detectButtonShortcut({ type: 'list', id: 'slot_pick:-1' })).toBeNull();
  });
});

describe('detectTemplateButtonShortcut', () => {
  const UUID = '6e956f67-6c89-4159-957b-10b61a03400d';

  it('deriva la acción del TÍTULO, no del prefijo del payload (cruce Meta↔Guacuco)', () => {
    // El botón "Cancelar cita" llegó con payload `confirm:<uuid>` por un desalineo
    // de orden en la plantilla de Meta. La acción debe ser cancel (lo que el
    // usuario tocó), con el uuid sacado del payload.
    const out = detectTemplateButtonShortcut({
      type: 'button',
      id: `confirm:${UUID}`,
      title: 'Cancelar cita',
    });
    expect(out).toEqual({ kind: 'cancel', value: UUID });
  });

  it('mapea "Confirmar" → confirm', () => {
    const out = detectTemplateButtonShortcut({
      type: 'button',
      id: `cancel:${UUID}`,
      title: 'Confirmar',
    });
    expect(out).toEqual({ kind: 'confirm', value: UUID });
  });

  it('mapea "Reagendar" → reschedule', () => {
    const out = detectTemplateButtonShortcut({
      type: 'button',
      id: `reschedule:${UUID}`,
      title: 'Reagendar',
    });
    expect(out).toEqual({ kind: 'reschedule', value: UUID });
  });

  it('título no reconocido → fallback al prefijo del payload', () => {
    const out = detectTemplateButtonShortcut({
      type: 'button',
      id: `confirm:${UUID}`,
      title: 'Algo raro',
    });
    expect(out).toEqual({ kind: 'confirm', value: UUID });
  });

  it('payload sin ":" → usa el id completo como uuid', () => {
    const out = detectTemplateButtonShortcut({
      type: 'button',
      id: UUID,
      title: 'Cancelar cita',
    });
    expect(out).toEqual({ kind: 'cancel', value: UUID });
  });

  it('returns null sin payload', () => {
    expect(detectTemplateButtonShortcut(null)).toBeNull();
    expect(detectTemplateButtonShortcut(undefined)).toBeNull();
  });
});
