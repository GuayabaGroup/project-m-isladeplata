/**
 * Formateo determinista de resultados como fallback cuando la síntesis LLM falla.
 *
 * Proyecta columnas del row YA ejecutado por Guacuco — no inventa datos
 * (§9 REGLAS_ISLADEPLATA anti-alucinación). Portado de IDP_OV1.
 *
 * - 0 rows → "No hay resultados".
 * - 1 row, 1 columna numérica → "Humanized key: value" (scalar aggregate).
 * - 1 row → intro + viñetas con cada campo visible.
 * - 2-3 rows → enumerado.
 * - 4+ rows → primeros 3 + "y N más".
 */

const HIDDEN_COLUMN_PATTERNS: ReadonlyArray<RegExp> = [
  /_uuid$/i,
  /^uuid$/i,
  /^id$/i,
  /_id$/i,
  /^created_at$/i,
  /^updated_at$/i,
  /^deleted_at$/i,
  /^row_num$/i,
];

const MAX_DETAILED_ROWS = 3;

function isHiddenColumn(name: string): boolean {
  return HIDDEN_COLUMN_PATTERNS.some((re) => re.test(name));
}

function humanizeColumnName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  if (spaced.length === 0) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function tryFormatIsoDate(value: string): string | null {
  // Date-only YYYY-MM-DD: parsear manualmente para evitar shift de timezone.
  // (new Date('2026-05-28') interpreta UTC midnight, lo que en UTC-3 da el día anterior.)
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return `${d}/${m}/${y}`;
  }
  const isoLike = /^\d{4}-\d{2}-\d{2}(T| )?(\d{2}:\d{2}(:\d{2})?)?/;
  if (!isoLike.test(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    const formatted = tryFormatIsoDate(value);
    if (formatted) return formatted;
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    const formatted = tryFormatIsoDate(value.toISOString());
    return formatted ?? value.toISOString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatRow(row: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(row)) {
    if (isHiddenColumn(key)) continue;
    if (raw === null || raw === undefined) continue;
    lines.push(`• ${humanizeColumnName(key)}: ${formatValue(raw)}`);
  }
  return lines.join('\n');
}

export function formatScalarAggregate(rows: Record<string, unknown>[]): string | null {
  if (!rows || rows.length !== 1) return null;
  const visibleEntries = Object.entries(rows[0] ?? {}).filter(
    ([key, val]) => !isHiddenColumn(key) && val !== null && val !== undefined,
  );
  if (visibleEntries.length !== 1) return null;
  const [key, value] = visibleEntries[0] as [string, unknown];
  if (typeof value !== 'number' && typeof value !== 'bigint') return null;
  return `${humanizeColumnName(key)}: ${String(value)}`;
}

export function formatRowsAsDetails(rows: Record<string, unknown>[], rowCount: number): string {
  if (!rows || rows.length === 0 || rowCount === 0) {
    return 'No hay resultados.';
  }
  const scalar = formatScalarAggregate(rows);
  if (scalar !== null) return scalar;

  if (rows.length === 1) {
    return `Este es el detalle:\n${formatRow(rows[0] as Record<string, unknown>)}`;
  }

  const detailed = rows.slice(0, MAX_DETAILED_ROWS);
  const remaining = rowCount - detailed.length;
  const parts: string[] = ['Estos son los detalles:'];
  detailed.forEach((row, idx) => {
    parts.push(`${idx + 1}.\n${formatRow(row)}`);
  });
  if (remaining > 0) {
    parts.push(`y ${remaining} resultado${remaining === 1 ? '' : 's'} más.`);
  }
  return parts.join('\n');
}
