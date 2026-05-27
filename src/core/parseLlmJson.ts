import type { Logger } from 'winston';

/**
 * Parseo defensivo de JSON emitido por un LLM. NUNCA lanza — retorna `null`
 * cuando no detecta JSON parseable. El caller decide qué hacer (típicamente:
 * fail-open a un default seguro).
 *
 * Estrategias en orden:
 *   1. Parsear el raw directo (caso ideal: el modelo respetó el contrato).
 *   2. Extraer bloque ```json ... ``` markdown.
 *   3. Extraer cualquier bloque ``` ... ``` y parsear.
 *   4. Detectar primer `{` o `[` y parsear desde ahí balanceando llaves.
 *
 * Log warn (con el `component` del caller) cuando todos los intentos fallan,
 * para poder triagear si el modelo se desvía sistemáticamente del contrato.
 */
export function parseLlmJson<T>(
  raw: string,
  logger: Logger,
  context: { component: string },
): T | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    logger.warn('parseLlmJson received empty input', context);
    return null;
  }

  const candidates = collectCandidates(raw);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next
    }
  }

  logger.warn('parseLlmJson failed to extract JSON', {
    ...context,
    rawPreview: raw.slice(0, 120),
  });
  return null;
}

function collectCandidates(raw: string): string[] {
  const out: string[] = [];
  const trimmed = raw.trim();
  out.push(trimmed);

  const fencedJson = matchFenced(trimmed, /```json\s*([\s\S]*?)```/i);
  if (fencedJson) out.push(fencedJson.trim());

  const fencedAny = matchFenced(trimmed, /```\s*([\s\S]*?)```/);
  if (fencedAny) out.push(fencedAny.trim());

  const balanced = extractBalanced(trimmed);
  if (balanced) out.push(balanced);

  return out;
}

function matchFenced(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m?.[1] ?? null;
}

/**
 * Extrae el primer JSON balanceado encontrado en el texto. Maneja strings
 * con escapes para no confundir `{` o `}` dentro de cadenas.
 */
function extractBalanced(text: string): string | null {
  const start = findFirstOpener(text);
  if (start === -1) return null;
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function findFirstOpener(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}
