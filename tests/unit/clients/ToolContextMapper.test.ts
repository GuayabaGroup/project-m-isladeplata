import { describe, expect, it } from 'vitest';
import { toolContextFromIdentity } from '../../../src/clients/mappers/ToolContextMapper.js';
import type { Identity } from '../../../src/core/types/Identity.js';

const BASE_IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'profile-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

describe('toolContextFromIdentity', () => {
  it('maps the canonical guard keys from identity', () => {
    expect(toolContextFromIdentity(BASE_IDENTITY)).toEqual({
      profile_uuid: 'profile-1',
      profile_type: 'client',
      business_uuid: 'biz-1',
    });
  });

  it('includes role_id only when present (staff)', () => {
    const staff: Identity = { ...BASE_IDENTITY, profileType: 'staff', roleId: 3 };
    expect(toolContextFromIdentity(staff)).toEqual({
      profile_uuid: 'profile-1',
      profile_type: 'staff',
      business_uuid: 'biz-1',
      role_id: 3,
    });
  });

  it('omits role_id when undefined (no role_id key in payload)', () => {
    const ctx = toolContextFromIdentity(BASE_IDENTITY);
    expect('role_id' in ctx).toBe(false);
  });

  it('never emits business_allia_id (Guacuco reads it from parameters, not context)', () => {
    const ctx = toolContextFromIdentity(BASE_IDENTITY) as Record<string, unknown>;
    expect(ctx.business_allia_id).toBeUndefined();
  });
});
