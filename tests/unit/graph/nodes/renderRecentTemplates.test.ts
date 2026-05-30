import { describe, expect, it } from 'vitest';
import type { RecentTemplate } from '../../../../src/core/types/RecentTemplate.js';
import { renderRecentTemplatesContext } from '../../../../src/graph/nodes/renderRecentTemplates.js';

function makeTemplate(overrides: Partial<RecentTemplate> = {}): RecentTemplate {
  return {
    templateName: 'p11_appointment_reminder_24h',
    userType: 'client',
    langCode: 'es',
    parameters: [
      { type: 'text', text: 'Juan' },
      { type: 'text', text: '30/05/2026' },
      { type: 'text', text: '11:30' },
    ],
    channelPhoneNumberId: 'pn-1',
    metaMessageId: 'wamid.ABC',
    status: 'sent',
    sourceComponent: 'notification.appointment',
    platformId: 3,
    appointmentUuid: null,
    createdAt: '2026-05-29T14:30:00Z',
    ...overrides,
  };
}

describe('renderRecentTemplatesContext', () => {
  it('returns empty string for no templates', () => {
    expect(renderRecentTemplatesContext([])).toBe('');
  });

  it('renders a known template (registry hit) with description + params', () => {
    const out = renderRecentTemplatesContext([makeTemplate()]);
    expect(out).toContain('Recordatorio de un turno próximo');
    expect(out).toContain('Datos: Juan, 30/05/2026, 11:30.');
    expect(out).toContain('El más reciente');
    // Hint de intent del recordatorio.
    expect(out).toMatch(/confirmar|cancelar|reagendar/i);
  });

  it('matches confirm-appointment family by prefix and includes its intent hint', () => {
    const out = renderRecentTemplatesContext([
      makeTemplate({ templateName: 'p1_confirm_appointment_wservices_2' }),
    ]);
    expect(out).toContain('Pedido de confirmación de un turno');
    expect(out).toMatch(/CONFIRMAR/);
    expect(out).toMatch(/CANCELAR/);
  });

  it('normalizes a leading underscore in the template name', () => {
    const out = renderRecentTemplatesContext([
      makeTemplate({ templateName: '_p7_daily_summary_3_appointment' }),
    ]);
    expect(out).toContain('Resumen diario');
  });

  it('falls back to a generic line for unknown template names', () => {
    const out = renderRecentTemplatesContext([
      makeTemplate({ templateName: 'totally_unknown_template', parameters: [] }),
    ]);
    expect(out).toContain('Mensaje automático "totally_unknown_template".');
  });

  it('caps the rendered list at 3 (most recent first)', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      makeTemplate({ templateName: 'p10_cancel_appointment_1', metaMessageId: `m-${i}` }),
    );
    const out = renderRecentTemplatesContext(many);
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
  });

  it('omits the Datos suffix when there are no text parameters', () => {
    const out = renderRecentTemplatesContext([
      makeTemplate({ templateName: 'p10_cancel_appointment_1', parameters: [] }),
    ]);
    expect(out).toContain('Aviso de que un turno fue cancelado.');
    expect(out).not.toContain('Datos:');
  });
});
