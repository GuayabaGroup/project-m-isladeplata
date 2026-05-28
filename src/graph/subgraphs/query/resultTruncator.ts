/**
 * Trunca resultados antes de pasarlos al LLM de síntesis. Portado IDP_OV1.
 *
 * Estrategia:
 *   1. Cada celda con string > MAX_CELL_CHARS → cortar y sufijo "...".
 *   2. Reducir filas progresivamente hasta que JSON total ≤ MAX_SYNTHESIS_CHARS.
 *
 * Evita exceder el token limit del LLM con resultsets grandes.
 */

const MAX_CELL_CHARS = 200;
const MAX_SYNTHESIS_CHARS = 50_000;

export interface TruncationResult {
  rows: Record<string, unknown>[];
  wasTruncated: boolean;
  originalCount: number;
}

export function truncateResultsForSynthesis(rows: Record<string, unknown>[]): TruncationResult {
  const originalCount = rows.length;
  if (rows.length === 0) {
    return { rows: [], wasTruncated: false, originalCount: 0 };
  }

  const cellTruncated: Record<string, unknown>[] = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value == null) {
        out[key] = value;
        continue;
      }
      const strVal = String(value);
      out[key] = strVal.length > MAX_CELL_CHARS ? `${strVal.slice(0, MAX_CELL_CHARS)}...` : value;
    }
    return out;
  });

  let truncatedRows = cellTruncated;
  let wasTruncated = false;
  while (truncatedRows.length > 0) {
    const serialized = JSON.stringify(truncatedRows);
    if (serialized.length <= MAX_SYNTHESIS_CHARS) break;
    wasTruncated = true;
    truncatedRows = truncatedRows.slice(0, -1);
  }

  return { rows: truncatedRows, wasTruncated, originalCount };
}
