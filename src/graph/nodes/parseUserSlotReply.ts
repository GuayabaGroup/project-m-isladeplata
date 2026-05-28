/**
 * Helper puro: extrae fecha (YYYY-MM-DD) y hora (HH:mm) de texto libre del
 * usuario. **Nunca llama LLM** — heurística rule-based + Intl date math.
 *
 * Filosofía:
 * - Anti-alucinación (§9 REGLAS): valores críticos NO los produce LLM.
 * - Si la entrada es ambigua o el helper no puede mapear → `null` para el
 *   slot correspondiente. El caller decide preguntar.
 *
 * Convención de zona horaria: la zona viene en `identity.timezone`
 * (IANA, ej. "America/Argentina/Buenos_Aires"). Toda fecha se computa
 * relativa al "hoy" en esa zona — NUNCA UTC.
 *
 * Heurística PM en horario comercial (decisión §11 PLAN_H4): "4" → 16:00 si
 * está dentro del horario comercial general (8-20). "9" o menor → AM.
 */

export interface ParsedSlots {
  date: string | null;
  time: string | null;
}

const RELATIVE_DAYS: ReadonlyArray<{ pattern: RegExp; offset: number }> = [
  { pattern: /\bhoy\b/i, offset: 0 },
  { pattern: /\bmañana\b/i, offset: 1 },
  { pattern: /\bpasado\s*mañana\b/i, offset: 2 },
];

const WEEKDAYS: ReadonlyArray<{ pattern: RegExp; weekday: number }> = [
  // weekday: 0=Sunday, 1=Monday, ..., 6=Saturday (matchea Date.getDay() local)
  { pattern: /\b(lunes)\b/i, weekday: 1 },
  { pattern: /\b(martes)\b/i, weekday: 2 },
  { pattern: /\b(mi[eé]rcoles|miercoles)\b/i, weekday: 3 },
  { pattern: /\b(jueves)\b/i, weekday: 4 },
  { pattern: /\b(viernes)\b/i, weekday: 5 },
  { pattern: /\b(s[aá]bado|sabado)\b/i, weekday: 6 },
  { pattern: /\b(domingo)\b/i, weekday: 0 },
];

const MONTH_NAMES: ReadonlyMap<string, number> = new Map([
  ['enero', 1],
  ['febrero', 2],
  ['marzo', 3],
  ['abril', 4],
  ['mayo', 5],
  ['junio', 6],
  ['julio', 7],
  ['agosto', 8],
  ['septiembre', 9],
  ['setiembre', 9],
  ['octubre', 10],
  ['noviembre', 11],
  ['diciembre', 12],
]);

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const SPANISH_DATE_RE = /\b(\d{1,2})\s+(?:de\s+)?([a-záé]+)(?:\s+(?:de\s+)?(\d{2,4}))?\b/i;

const TIME_24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const TIME_HOUR_ONLY_RE = /\b(\d{1,2})\s*(am|pm|hs?|h)?\b/i;

/**
 * Parsea fecha + hora de un texto. `now` permite override para tests.
 */
export function parseUserSlotReply(
  text: string,
  timezone: string,
  now: Date = new Date(),
): ParsedSlots {
  const clean = text.trim();
  if (clean.length === 0) return { date: null, time: null };

  const date = extractDate(clean, timezone, now);
  const time = extractTime(clean);
  return { date, time };
}

// ============================================================================
// Date extraction
// ============================================================================

function extractDate(text: string, timezone: string, now: Date): string | null {
  // 1. Día relativo (hoy/mañana/pasado mañana) — orden importa: "pasado mañana" antes que "mañana"
  for (const { pattern, offset } of [...RELATIVE_DAYS].reverse()) {
    if (pattern.test(text)) return shiftDay(now, offset, timezone);
  }

  // 2. Día de la semana (próxima ocurrencia)
  for (const { pattern, weekday } of WEEKDAYS) {
    if (pattern.test(text)) return nextWeekday(now, weekday, timezone);
  }

  // 3. ISO YYYY-MM-DD
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    if (y && m && d) return `${y}-${m}-${d}`;
  }

  // 4. Spanish "15 de marzo" / "15 marzo"
  const spanish = SPANISH_DATE_RE.exec(text);
  if (spanish) {
    const day = Number.parseInt(spanish[1] ?? '', 10);
    const monthName = (spanish[2] ?? '').toLowerCase();
    const month = MONTH_NAMES.get(monthName);
    if (Number.isInteger(day) && day >= 1 && day <= 31 && month) {
      const year = parseYear(spanish[3]) ?? currentYearInTimezone(now, timezone);
      return formatYmd(year, month, day);
    }
  }

  // 5. DD/MM (o DD/MM/YYYY)
  const slash = SLASH_DATE_RE.exec(text);
  if (slash) {
    const day = Number.parseInt(slash[1] ?? '', 10);
    const month = Number.parseInt(slash[2] ?? '', 10);
    if (
      Number.isInteger(day) &&
      Number.isInteger(month) &&
      day >= 1 &&
      day <= 31 &&
      month >= 1 &&
      month <= 12
    ) {
      const year = parseYear(slash[3]) ?? currentYearInTimezone(now, timezone);
      return formatYmd(year, month, day);
    }
  }

  return null;
}

function parseYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 100) return 2000 + n;
  return n;
}

function shiftDay(now: Date, offsetDays: number, timezone: string): string {
  const { year, month, day } = ymdInTimezone(now, timezone);
  // Construye una fecha UTC al mediodía del día computado para evitar DST edge cases.
  const utc = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0));
  const parts = ymdInTimezone(utc, timezone);
  return formatYmd(parts.year, parts.month, parts.day);
}

function nextWeekday(now: Date, targetWeekday: number, timezone: string): string {
  // Calcula el weekday actual EN la zona del usuario.
  const todayInZone = ymdInTimezone(now, timezone);
  const todayUtc = new Date(Date.UTC(todayInZone.year, todayInZone.month - 1, todayInZone.day));
  const todayWeekday = todayUtc.getUTCDay();
  let diff = targetWeekday - todayWeekday;
  if (diff <= 0) diff += 7; // próxima ocurrencia (nunca "hoy" si coincide)
  return shiftDay(now, diff, timezone);
}

function ymdInTimezone(d: Date, timezone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
  };
}

function currentYearInTimezone(now: Date, timezone: string): number {
  return ymdInTimezone(now, timezone).year;
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

// ============================================================================
// Time extraction (heurística PM en horario comercial — decisión §11 PLAN_H4)
// ============================================================================

const PM_HEURISTIC_THRESHOLD = 8; // hour <= este valor → asumir PM en horario comercial

function extractTime(text: string): string | null {
  // 1. HH:mm explícito (prioridad absoluta)
  const explicit = TIME_24_RE.exec(text);
  if (explicit) {
    const h = Number.parseInt(explicit[1] ?? '', 10);
    const m = Number.parseInt(explicit[2] ?? '', 10);
    if (validHour(h) && validMinute(m)) return formatHm(h, m);
  }

  // 2. Solo número con sufijo (am/pm/hs/h) o sin
  const hourOnly = TIME_HOUR_ONLY_RE.exec(text);
  if (hourOnly) {
    const h = Number.parseInt(hourOnly[1] ?? '', 10);
    const suffix = (hourOnly[2] ?? '').toLowerCase();
    if (!validHour(h)) return null;

    if (suffix === 'am') return formatHm(h === 12 ? 0 : h, 0);
    if (suffix === 'pm') return formatHm(h === 12 ? 12 : h + 12, 0);
    if (suffix === 'hs' || suffix === 'h') return formatHm(h, 0);

    // Sin sufijo: heurística PM. h ∈ [1, PM_HEURISTIC_THRESHOLD] → +12 (horario comercial).
    // h ≥ 9 sin sufijo → tal cual (asumimos AM/24h "9hs" implícito).
    if (h >= 1 && h <= PM_HEURISTIC_THRESHOLD) return formatHm(h + 12, 0);
    if (h === 0) return formatHm(0, 0);
    if (h <= 23) return formatHm(h, 0);
  }

  return null;
}

function validHour(h: number): boolean {
  return Number.isInteger(h) && h >= 0 && h <= 23;
}
function validMinute(m: number): boolean {
  return Number.isInteger(m) && m >= 0 && m <= 59;
}
function formatHm(h: number, m: number): string {
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
