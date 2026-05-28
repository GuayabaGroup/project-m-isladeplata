import { describe, expect, it } from 'vitest';
import type { Identity } from '../../../../../src/core/types/Identity.js';
import {
  type TemporalContext,
  buildSqlGenerationPrompt,
} from '../../../../../src/graph/subgraphs/query/prompts/querySql.js';

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'client-123',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

const TEMPORAL: TemporalContext = {
  currentDate: '2026-05-28',
  currentTimestamp: '2026-05-28 10:00:00',
  dayOfWeek: 3,
};

function build(history?: { role: 'user' | 'assistant'; content: string }[]) {
  return buildSqlGenerationPrompt(
    '¿y la próxima?',
    'TABLE app.turnos: client_uuid uuid, fecha date',
    IDENTITY,
    'app',
    25,
    TEMPORAL,
    undefined,
    history,
  );
}

describe('buildSqlGenerationPrompt — anáforas + drill-down', () => {
  it('omits the history block when there is no history', () => {
    const { systemPrompt } = build();
    // El encabezado del bloque y las líneas de turnos viven SOLO con historial
    // (las reglas #4 referencian "REGLA DE REFERENCIAS"/"DRILL-DOWN" siempre).
    expect(systemPrompt).not.toContain('HISTORIAL RECIENTE');
    expect(systemPrompt).not.toContain('[USUARIO]:');
  });

  it('injects the history block + referencias + drill-down when history is present', () => {
    const { systemPrompt } = build([
      { role: 'user', content: '¿cuántos turnos tengo esta semana?' },
      { role: 'assistant', content: 'Tenés 2 turnos.' },
    ]);
    expect(systemPrompt).toContain('HISTORIAL RECIENTE');
    expect(systemPrompt).toContain('REGLA DE REFERENCIAS');
    expect(systemPrompt).toContain('DRILL-DOWN (mismo sujeto');
    // Los turnos del historial se renderizan con etiqueta de rol.
    expect(systemPrompt).toContain('[USUARIO]: ¿cuántos turnos tengo esta semana?');
    expect(systemPrompt).toContain('[ASISTENTE]: Tenés 2 turnos.');
    // El filtro de perfil usa la columna correcta para el rol (client).
    expect(systemPrompt).toContain("client_uuid = 'client-123'");
  });
});
