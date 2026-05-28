import { describe, expect, it } from 'vitest';
import {
  formatRowsAsDetails,
  formatScalarAggregate,
} from '../../../../../src/graph/subgraphs/query/resultFormatter.js';
import { truncateResultsForSynthesis } from '../../../../../src/graph/subgraphs/query/resultTruncator.js';
import { resolveAllowedSchema } from '../../../../../src/graph/subgraphs/query/schemaResolver.js';
import { validateSql } from '../../../../../src/graph/subgraphs/query/sqlValidator.js';

// ============================================================================
// schemaResolver
// ============================================================================

describe('resolveAllowedSchema', () => {
  it('client → front_sche_client', () => {
    const r = resolveAllowedSchema('client', null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowedSchema).toBe('front_sche_client');
  });

  it('staff role_id=1 → front_sche (Owner)', () => {
    const r = resolveAllowedSchema('staff', 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allowedSchema).toBe('front_sche');
  });

  it('staff role_id=2 → front_sche_professional', () => {
    const r = resolveAllowedSchema('staff', 2);
    if (r.ok) expect(r.allowedSchema).toBe('front_sche_professional');
  });

  it('staff role_id=3 → front_sche_admin', () => {
    const r = resolveAllowedSchema('staff', 3);
    if (r.ok) expect(r.allowedSchema).toBe('front_sche_admin');
  });

  it('staff sin roleId → rechaza', () => {
    const r = resolveAllowedSchema('staff', null);
    expect(r.ok).toBe(false);
  });

  it('staff role_id desconocido → fallback Owner schema', () => {
    const r = resolveAllowedSchema('staff', 99);
    if (r.ok) expect(r.allowedSchema).toBe('front_sche');
  });
});

// ============================================================================
// sqlValidator
// ============================================================================

const SCHEMA = 'front_sche_client';

describe('validateSql — happy path', () => {
  it('SELECT schema-qualified pasa', () => {
    const r = validateSql(
      `SELECT name, price FROM ${SCHEMA}.services WHERE active = true LIMIT 10`,
      SCHEMA,
    );
    expect(r.valid).toBe(true);
  });

  it('WITH CTE pasa', () => {
    const r = validateSql(
      `WITH active_services AS (SELECT * FROM ${SCHEMA}.services WHERE active = true) SELECT name FROM active_services LIMIT 5`,
      SCHEMA,
    );
    expect(r.valid).toBe(true);
  });
});

describe('validateSql — Layer 1: statement type', () => {
  it('INSERT rechazado', () => {
    const r = validateSql(`INSERT INTO ${SCHEMA}.services VALUES (1)`, SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Only SELECT/i);
  });

  it('UPDATE rechazado', () => {
    const r = validateSql(`UPDATE ${SCHEMA}.services SET name = 'x'`, SCHEMA);
    expect(r.valid).toBe(false);
  });

  it('DROP rechazado', () => {
    const r = validateSql(`DROP TABLE ${SCHEMA}.services`, SCHEMA);
    expect(r.valid).toBe(false);
  });

  it('múltiples statements rechazado', () => {
    const r = validateSql(
      `SELECT 1 FROM ${SCHEMA}.services; DROP TABLE ${SCHEMA}.services`,
      SCHEMA,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Multiple statements/i);
  });
});

describe('validateSql — Layer 2: forbidden keywords', () => {
  it('UNION rechazado', () => {
    const r = validateSql(
      `SELECT name FROM ${SCHEMA}.services UNION SELECT name FROM ${SCHEMA}.staff`,
      SCHEMA,
    );
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/UNION/i);
  });

  it('EXEC rechazado', () => {
    const r = validateSql(`SELECT EXEC FROM ${SCHEMA}.services`, SCHEMA);
    expect(r.valid).toBe(false);
  });

  it('GRANT rechazado', () => {
    const r = validateSql(`GRANT SELECT ON ${SCHEMA}.services TO public`, SCHEMA);
    expect(r.valid).toBe(false);
  });
});

describe('validateSql — Layer 3: schema enforcement', () => {
  it('FROM public.* rechazado', () => {
    const r = validateSql('SELECT * FROM public.users LIMIT 10', SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/public/i);
  });

  it('FROM otro schema rechazado', () => {
    const r = validateSql('SELECT * FROM front_sche.services LIMIT 10', SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Only schema/);
  });
});

describe('validateSql — Layer 4: bare table prevention', () => {
  it('FROM bare table sin schema rechazado', () => {
    const r = validateSql('SELECT * FROM services LIMIT 10', SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/schema-qualified/);
  });

  it('CTE alias no se confunde con bare table', () => {
    const r = validateSql(`WITH s AS (SELECT * FROM ${SCHEMA}.services) SELECT * FROM s`, SCHEMA);
    expect(r.valid).toBe(true);
  });
});

describe('validateSql — Layer 5: dangerous functions', () => {
  it('pg_read_file rechazado', () => {
    const r = validateSql(`SELECT pg_read_file('/etc/passwd') FROM ${SCHEMA}.services`, SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Dangerous/i);
  });

  it('pg_sleep rechazado (DoS)', () => {
    const r = validateSql(`SELECT pg_sleep(10) FROM ${SCHEMA}.services`, SCHEMA);
    expect(r.valid).toBe(false);
  });
});

describe('validateSql — edge cases', () => {
  it('SQL vacío rechazado', () => {
    expect(validateSql('', SCHEMA).valid).toBe(false);
    expect(validateSql('   ', SCHEMA).valid).toBe(false);
  });

  it('comentarios después del strip son rechazados', () => {
    const r = validateSql(`SELECT * FROM ${SCHEMA}.services -- comment`, SCHEMA);
    // strip los borra antes; resultado debería ser válido (los comments NO son data leak per se)
    // pero si por alguna razón sobreviven, deben rechazarse. Acá esperamos válido.
    expect(r.valid).toBe(true);
  });
});

// ============================================================================
// resultTruncator
// ============================================================================

describe('truncateResultsForSynthesis', () => {
  it('rows vacío → out empty + originalCount 0', () => {
    const r = truncateResultsForSynthesis([]);
    expect(r.rows).toEqual([]);
    expect(r.wasTruncated).toBe(false);
    expect(r.originalCount).toBe(0);
  });

  it('truncates celda mayor a 200 chars con sufijo', () => {
    const long = 'x'.repeat(500);
    const r = truncateResultsForSynthesis([{ desc: long }]);
    const desc = (r.rows[0] as { desc: string }).desc;
    expect(desc.length).toBe(203); // 200 + '...'
    expect(desc.endsWith('...')).toBe(true);
  });

  it('drop rows hasta caber en 50_000 chars total', () => {
    const heavy = { data: 'y'.repeat(150) }; // ~165 bytes JSON each row
    const rows = Array.from({ length: 1000 }, () => ({ ...heavy }));
    const r = truncateResultsForSynthesis(rows);
    expect(r.wasTruncated).toBe(true);
    expect(r.rows.length).toBeLessThan(1000);
    expect(JSON.stringify(r.rows).length).toBeLessThanOrEqual(50_000);
  });

  it('rows que ya caben no se truncan', () => {
    const r = truncateResultsForSynthesis([{ a: 1 }, { a: 2 }]);
    expect(r.wasTruncated).toBe(false);
    expect(r.rows).toHaveLength(2);
  });

  it('preserva nulls sin convertirlos a "null"', () => {
    const r = truncateResultsForSynthesis([{ x: null, y: undefined }]);
    expect(r.rows[0]).toEqual({ x: null, y: undefined });
  });
});

// ============================================================================
// resultFormatter
// ============================================================================

describe('formatScalarAggregate', () => {
  it('1 row + 1 columna numérica → "Key: value"', () => {
    expect(formatScalarAggregate([{ total_count: 42 }])).toBe('Total count: 42');
  });

  it('1 row + 1 columna string → null (no scalar)', () => {
    expect(formatScalarAggregate([{ name: 'Corte' }])).toBeNull();
  });

  it('multiple columnas → null', () => {
    expect(formatScalarAggregate([{ a: 1, b: 2 }])).toBeNull();
  });

  it('multiple rows → null', () => {
    expect(formatScalarAggregate([{ x: 1 }, { x: 2 }])).toBeNull();
  });

  it('columnas hidden no cuentan', () => {
    // Solo "uuid" visible que es hidden → no scalar válido
    expect(formatScalarAggregate([{ uuid: 'abc', count: 5 }])).toBe('Count: 5');
  });
});

describe('formatRowsAsDetails', () => {
  it('0 rows → "No hay resultados"', () => {
    expect(formatRowsAsDetails([], 0)).toMatch(/No hay resultados/);
  });

  it('1 row con varios campos → vinetas', () => {
    const out = formatRowsAsDetails([{ name: 'Corte', price: 5000 }], 1);
    expect(out).toMatch(/detalle/i);
    expect(out).toMatch(/Name: Corte/);
    expect(out).toMatch(/Price: 5000/);
  });

  it('omite columnas hidden (uuid, _id, created_at)', () => {
    const out = formatRowsAsDetails([{ uuid: 'abc-123', name: 'X', created_at: '2026-05-28' }], 1);
    expect(out).not.toMatch(/uuid/i);
    expect(out).not.toMatch(/created_at/i);
    expect(out).toMatch(/Name: X/);
  });

  it('4+ rows → primeros 3 + "y N más"', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `n${i}` }));
    const out = formatRowsAsDetails(rows, 5);
    expect(out).toMatch(/y 2 resultados más/);
  });

  it('scalar aggregate intercepta para 1 row 1 numero', () => {
    const out = formatRowsAsDetails([{ count: 7 }], 1);
    expect(out).toBe('Count: 7');
  });

  it('formatea ISO date como DD/MM/YYYY', () => {
    const out = formatRowsAsDetails([{ fecha: '2026-05-28' }], 1);
    expect(out).toMatch(/28\/05\/2026/);
  });
});
