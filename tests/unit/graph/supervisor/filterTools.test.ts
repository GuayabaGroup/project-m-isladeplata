import { describe, expect, it } from 'vitest';
import { getAvailableTools, isToolAllowed } from '../../../../src/graph/supervisor/filterTools.js';

describe('getAvailableTools', () => {
  it('client gets retrieve_manzanillo_url but NOT connect_mercado_pago', () => {
    const tools = getAvailableTools('client');
    expect(tools.has('retrieve_manzanillo_url')).toBe(true);
    expect(tools.has('connect_mercado_pago')).toBe(false);
  });

  it('staff gets connect_mercado_pago but NOT retrieve_manzanillo_url', () => {
    const tools = getAvailableTools('staff');
    expect(tools.has('connect_mercado_pago')).toBe(true);
    expect(tools.has('retrieve_manzanillo_url')).toBe(false);
  });

  it('both roles get core subgraphs and shared tools', () => {
    for (const role of ['client', 'staff'] as const) {
      const tools = getAvailableTools(role);
      expect(tools.has('schedule')).toBe(true);
      expect(tools.has('reschedule')).toBe(true);
      expect(tools.has('cancel')).toBe(true);
      expect(tools.has('confirm')).toBe(true);
      expect(tools.has('query')).toBe(true);
      expect(tools.has('generate_verification_url')).toBe(true);
      expect(tools.has('forward_message')).toBe(true);
    }
  });
});

describe('isToolAllowed', () => {
  it('returns true for tools in the role set', () => {
    expect(isToolAllowed('schedule', 'client')).toBe(true);
    expect(isToolAllowed('connect_mercado_pago', 'staff')).toBe(true);
  });

  it('returns false for tools outside the role set', () => {
    expect(isToolAllowed('connect_mercado_pago', 'client')).toBe(false);
    expect(isToolAllowed('retrieve_manzanillo_url', 'staff')).toBe(false);
  });
});
