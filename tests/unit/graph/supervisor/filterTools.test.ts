import { describe, expect, it } from 'vitest';
import { getAvailableTools, isToolAllowed } from '../../../../src/graph/supervisor/filterTools.js';

const OWNER_ROLE_ID = 1;
const EMPLOYEE_ROLE_ID = 2;
const ANY_PLATFORM = 1;

describe('getAvailableTools', () => {
  it('client gets retrieve_manzanillo_url but NOT connect_mercado_pago (role/platform ignored)', () => {
    const tools = getAvailableTools('client', OWNER_ROLE_ID, ANY_PLATFORM);
    expect(tools.has('retrieve_manzanillo_url')).toBe(true);
    expect(tools.has('connect_mercado_pago')).toBe(false);
  });

  it('owner staff (role_id=1) gets connect_mercado_pago + generate_verification_url', () => {
    const tools = getAvailableTools('staff', OWNER_ROLE_ID, ANY_PLATFORM);
    expect(tools.has('connect_mercado_pago')).toBe(true);
    expect(tools.has('generate_verification_url')).toBe(true);
    expect(tools.has('retrieve_manzanillo_url')).toBe(false);
  });

  it('non-owner staff (role_id=2) does NOT get owner-only tools', () => {
    const tools = getAvailableTools('staff', EMPLOYEE_ROLE_ID, ANY_PLATFORM);
    expect(tools.has('connect_mercado_pago')).toBe(false);
    expect(tools.has('generate_verification_url')).toBe(false);
    // ...but keeps the shared staff tools.
    expect(tools.has('schedule')).toBe(true);
    expect(tools.has('cancel')).toBe(true);
    expect(tools.has('query')).toBe(true);
    expect(tools.has('forward_message')).toBe(true);
  });

  it('staff without roleId falls back to non-owner set', () => {
    const tools = getAvailableTools('staff');
    expect(tools.has('connect_mercado_pago')).toBe(false);
    expect(tools.has('generate_verification_url')).toBe(false);
    expect(tools.has('schedule')).toBe(true);
  });

  it('owner rule applies on any platform (wildcard platform)', () => {
    for (const platformId of [1, 2, 99]) {
      const tools = getAvailableTools('staff', OWNER_ROLE_ID, platformId);
      expect(tools.has('connect_mercado_pago')).toBe(true);
    }
  });

  it('client gets core subgraphs and shared tools regardless of role/platform', () => {
    const tools = getAvailableTools('client', EMPLOYEE_ROLE_ID, 99);
    for (const t of [
      'schedule',
      'reschedule',
      'cancel',
      'confirm',
      'query',
      'forward_message',
    ] as const) {
      expect(tools.has(t)).toBe(true);
    }
  });

  it('all staff (owner + non-owner) get core subgraphs and forward_message', () => {
    for (const roleId of [OWNER_ROLE_ID, EMPLOYEE_ROLE_ID, undefined]) {
      const tools = getAvailableTools('staff', roleId, ANY_PLATFORM);
      for (const t of [
        'schedule',
        'reschedule',
        'cancel',
        'confirm',
        'query',
        'forward_message',
      ] as const) {
        expect(tools.has(t)).toBe(true);
      }
    }
  });
});

describe('isToolAllowed', () => {
  it('returns true for tools in the resolved set', () => {
    expect(isToolAllowed('schedule', 'client')).toBe(true);
    expect(isToolAllowed('connect_mercado_pago', 'staff', OWNER_ROLE_ID)).toBe(true);
  });

  it('returns false for tools outside the resolved set', () => {
    expect(isToolAllowed('connect_mercado_pago', 'client')).toBe(false);
    expect(isToolAllowed('retrieve_manzanillo_url', 'staff', OWNER_ROLE_ID)).toBe(false);
    // owner-only tool denied to non-owner staff
    expect(isToolAllowed('connect_mercado_pago', 'staff', EMPLOYEE_ROLE_ID)).toBe(false);
    expect(isToolAllowed('generate_verification_url', 'staff', EMPLOYEE_ROLE_ID)).toBe(false);
  });
});
