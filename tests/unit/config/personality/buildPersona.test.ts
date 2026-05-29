import { describe, expect, it } from 'vitest';
import { getAccentInstruction } from '../../../../src/config/personality/accentInstructions.js';
import { resolveAssistantName } from '../../../../src/config/personality/assistantName.js';
import { buildPersona, toPersonaContext } from '../../../../src/config/personality/buildPersona.js';
import type { Identity } from '../../../../src/core/types/Identity.js';

const BASE_IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'p-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
  tenantName: 'Estética Norte',
  agentName: null,
  countryCode: 'ARG',
};

describe('resolveAssistantName', () => {
  it('staff always gets the platform default, ignoring agentName', () => {
    expect(resolveAssistantName(1, 'staff', 'Custom')).toBe('Ally');
    expect(resolveAssistantName(2, 'staff', 'Custom')).toBe('Groomy');
    expect(resolveAssistantName(3, 'staff', 'Custom')).toBe('Divy');
  });

  it('client uses agentName when present, else platform default', () => {
    expect(resolveAssistantName(3, 'client', 'Rosita')).toBe('Rosita');
    expect(resolveAssistantName(3, 'client', null)).toBe('Divy');
    expect(resolveAssistantName(2, 'client', '   ')).toBe('Groomy');
  });

  it('falls back to Ally for unknown platform', () => {
    expect(resolveAssistantName(99, 'staff', null)).toBe('Ally');
    expect(resolveAssistantName(99, 'client', null)).toBe('Ally');
  });
});

describe('getAccentInstruction', () => {
  it('returns voseo for Argentina', () => {
    const accent = getAccentInstruction('ARG');
    expect(accent).toMatch(/Argentine/i);
    expect(accent).toContain('vos');
  });

  it('returns tuteo for Mexico', () => {
    const accent = getAccentInstruction('MEX');
    expect(accent).toMatch(/Mexican/i);
    expect(accent).toContain('tú');
  });

  it('is case-insensitive on the country code', () => {
    expect(getAccentInstruction('arg')).toBe(getAccentInstruction('ARG'));
  });

  it('falls back to neutral Spanish for null or unknown code', () => {
    const fallback = getAccentInstruction(null);
    expect(fallback).toMatch(/Latin American/i);
    expect(getAccentInstruction('ZZZ')).toBe(fallback);
  });
});

describe('buildPersona', () => {
  it('builds the Allia (Ally) persona for platformId 1', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY));
    expect(persona).toContain('You are Ally');
    expect(persona).toContain('Allia platform');
  });

  it('builds the Groomia (Groomy) persona for platformId 2', () => {
    const persona = buildPersona(toPersonaContext({ ...BASE_IDENTITY, platformId: 2 }));
    expect(persona).toContain('You are Groomy');
    expect(persona).toContain('pet grooming');
  });

  it('builds the Divapp (Divy) persona for platformId 3', () => {
    const persona = buildPersona(toPersonaContext({ ...BASE_IDENTITY, platformId: 3 }));
    expect(persona).toContain('You are Divy');
    expect(persona).toContain('beauty');
  });

  it('uses the custom agentName for clients', () => {
    const persona = buildPersona(
      toPersonaContext({ ...BASE_IDENTITY, platformId: 3, agentName: 'Rosita' }),
    );
    expect(persona).toContain('You are Rosita');
  });

  it('names the business (not the platform) as the greeted entity', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY));
    expect(persona).toContain('BUSINESS IDENTITY');
    expect(persona).toContain('Estética Norte');
    expect(persona).toMatch(/NEVER the internal platform name/i);
  });

  it('appends the accent instruction matching the country code', () => {
    const persona = buildPersona(toPersonaContext({ ...BASE_IDENTITY, countryCode: 'MEX' }));
    expect(persona).toMatch(/Mexican Spanish/i);
  });

  it('falls back to neutral Spanish when countryCode is missing', () => {
    const persona = buildPersona(toPersonaContext({ ...BASE_IDENTITY, countryCode: null }));
    expect(persona).toMatch(/Latin American/i);
  });

  it('always includes the WhatsApp response-formatting rule', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY));
    expect(persona).toContain('RESPONSE FORMATTING');
    expect(persona).toContain('single asterisks');
    expect(persona).toMatch(/NEVER use Markdown/i);
  });

  it('omits the AI-identity-disclosure block by default', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY));
    expect(persona).not.toContain('AI IDENTITY');
  });

  it('includes the AI-identity-disclosure block when opted in', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY), { aiIdentityDisclosure: true });
    expect(persona).toContain('AI IDENTITY');
    expect(persona).toContain('asistente virtual');
  });

  it('defaults businessName when tenantName is absent', () => {
    const { tenantName: _omit, ...noName } = BASE_IDENTITY;
    const ctx = toPersonaContext(noName as Identity);
    expect(ctx.businessName).toBe('el negocio');
  });
});

describe('buildPersona business_policies_and_notes (Nivel A)', () => {
  it('maps identity.businessGeneralComments into the persona context', () => {
    const ctx = toPersonaContext({
      ...BASE_IDENTITY,
      businessGeneralComments: 'Solo aceptamos efectivo.',
    });
    expect(ctx.businessPolicies).toBe('Solo aceptamos efectivo.');
  });

  it('emits the authoritative block with the notes when present', () => {
    const persona = buildPersona(
      toPersonaContext({
        ...BASE_IDENTITY,
        businessGeneralComments: 'Cancelaciones con 24h de anticipación.',
      }),
    );
    expect(persona).toContain('<business_policies_and_notes>');
    expect(persona).toContain('Cancelaciones con 24h de anticipación.');
    expect(persona).toMatch(/CONTEXTO AUTORITATIVO/i);
  });

  it('emits the block for staff profiles too (parity with IDP)', () => {
    const persona = buildPersona(
      toPersonaContext({
        ...BASE_IDENTITY,
        profileType: 'staff',
        businessGeneralComments: 'Transferencias aceptadas.',
      }),
    );
    expect(persona).toContain('<business_policies_and_notes>');
    expect(persona).toContain('Transferencias aceptadas.');
  });

  it('omits the block when comments are null', () => {
    const persona = buildPersona(toPersonaContext(BASE_IDENTITY));
    expect(persona).not.toContain('<business_policies_and_notes>');
  });

  it('omits the block when comments are empty or whitespace', () => {
    const empty = buildPersona(toPersonaContext({ ...BASE_IDENTITY, businessGeneralComments: '' }));
    const blank = buildPersona(
      toPersonaContext({ ...BASE_IDENTITY, businessGeneralComments: '   \n  ' }),
    );
    expect(empty).not.toContain('<business_policies_and_notes>');
    expect(blank).not.toContain('<business_policies_and_notes>');
  });

  it('escapes XML metacharacters in the notes', () => {
    const persona = buildPersona(
      toPersonaContext({
        ...BASE_IDENTITY,
        businessGeneralComments: 'Niños < 5 años & adultos > 65 gratis.',
      }),
    );
    expect(persona).toContain('Niños &lt; 5 años &amp; adultos &gt; 65 gratis.');
    expect(persona).not.toContain('< 5 años');
  });
});
