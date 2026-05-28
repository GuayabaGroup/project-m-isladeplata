/**
 * Validador local de seguridad SQL — defensa en profundidad antes de enviar
 * queries al `/query-processor/query` de Guacuco (que también valida).
 *
 * Portado de IDP_OV1 `src/security/SqlValidator.ts`. 5 capas:
 *   1. Statement type: solo SELECT o WITH...SELECT
 *   2. Forbidden keywords: DML/DDL/dangerous ops (token-level)
 *   3. Schema enforcement: solo el `allowedSchema`, bloquea `public.*`
 *   4. Bare table name prevention: requiere schema-qualified
 *   5. Dangerous functions: ~30 funciones de Postgres peligrosas
 *
 * No usa sqlparse (no disponible en TS). Tokeniza el SQL normalizado (sin
 * strings ni comentarios) con regex para evitar bypasses via string literals.
 */

export interface SqlValidationResult {
  valid: boolean;
  error?: string;
}

const FORBIDDEN_STATEMENT_TYPES = new Set([
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'INSERT',
  'UPDATE',
  'MERGE',
  'REPLACE',
]);

const FORBIDDEN_KEYWORDS = new Set([
  'EXEC',
  'EXECUTE',
  'CALL',
  'GRANT',
  'REVOKE',
  'COPY',
  'LOAD',
  'IMPORT',
  'EXPORT',
  'LOCK',
  'VACUUM',
  'ANALYZE',
  'EXPLAIN',
  'INTO',
]);

const DANGEROUS_FUNCTIONS = new RegExp(
  `\\b(${[
    'pg_read_file',
    'pg_read_binary_file',
    'pg_ls_dir',
    'pg_stat_file',
    'lo_import',
    'lo_export',
    'lo_open',
    'dblink',
    'dblink_exec',
    'xp_cmdshell',
    'xp_regread',
    'xmlparse',
    'xpath',
    'xpath_exists',
    'pg_shadow',
    'pg_authid',
    'pg_hba_file_rules',
    'pg_config',
    'pg_sleep',
    'pg_terminate_backend',
    'pg_cancel_backend',
    'current_setting',
    'set_config',
    'benchmark',
    'waitfor',
  ].join('|')})\\s*\\(`,
  'i',
);

const SQL_KEYWORDS_BEFORE_TABLE = new Set([
  'select',
  'where',
  'on',
  'inner',
  'left',
  'right',
  'outer',
  'cross',
  'full',
  'natural',
  'lateral',
  'and',
  'or',
  'not',
  'case',
  'when',
  'then',
  'else',
  'end',
  'as',
  'in',
  'exists',
  'between',
  'like',
  'ilike',
  'is',
  'null',
  'true',
  'false',
  'asc',
  'desc',
  'limit',
  'offset',
  'having',
  'group',
  'order',
  'by',
  'distinct',
  'all',
  'any',
  'some',
  'with',
  'recursive',
  'over',
  'partition',
  'row',
  'rows',
  'range',
  'unbounded',
  'preceding',
  'following',
  'current',
  'filter',
  'within',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'cast',
  // PostgreSQL date/time types — aparecen tras FROM en EXTRACT(field FROM type '...')
  'date',
  'time',
  'timestamp',
  'interval',
]);

function stripStringsAndComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateSql(sql: string, allowedSchema: string): SqlValidationResult {
  if (!sql || typeof sql !== 'string') return { valid: false, error: 'Invalid SQL query' };
  const trimmed = sql.trim();
  if (!trimmed) return { valid: false, error: 'Empty SQL query' };

  const normalized = stripStringsAndComments(trimmed);

  // Layer 1: solo SELECT o WITH
  const firstKeyword = normalized.match(/^\s*(\w+)/i)?.[1]?.toUpperCase();
  if (!firstKeyword || (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH')) {
    return {
      valid: false,
      error: `Only SELECT queries are allowed. Found: ${firstKeyword ?? 'unknown'}`,
    };
  }

  // Bloquear múltiples statements (batch injection via ;)
  if (/;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|WITH)\b/i.test(normalized)) {
    return { valid: false, error: 'Multiple statements are not allowed' };
  }

  // Layer 2: tokens prohibidos
  const tokens = normalized.toUpperCase().match(/\b[A-Z_]+\b/g) ?? [];
  for (const token of tokens) {
    if (FORBIDDEN_STATEMENT_TYPES.has(token)) {
      return { valid: false, error: `Write operation '${token}' is not allowed` };
    }
    if (FORBIDDEN_KEYWORDS.has(token)) {
      return { valid: false, error: `Operation '${token}' is not allowed` };
    }
    if (token === 'UNION') {
      return { valid: false, error: 'UNION queries are not allowed' };
    }
  }

  if (/--/.test(normalized) || /\/\*/.test(normalized)) {
    return { valid: false, error: 'SQL comments are not allowed' };
  }

  // Layer 3: schema enforcement
  const publicPattern = /\b(?:FROM|JOIN)\s+(public\.[a-zA-Z_]\w*)\b/gi;
  if (publicPattern.test(normalized)) {
    return { valid: false, error: "Access to 'public' schema is not allowed" };
  }

  const schemaRefPattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*\.[a-zA-Z_]\w*)\b/gi;
  let match: RegExpExecArray | null;
  match = schemaRefPattern.exec(normalized);
  while (match !== null) {
    const fullName = match[1] ?? '';
    const schemaPart = fullName.split('.')[0] ?? '';
    if (schemaPart.toLowerCase() !== allowedSchema.toLowerCase()) {
      return {
        valid: false,
        error: `Only schema '${allowedSchema}' is allowed. Found: ${fullName}`,
      };
    }
    match = schemaRefPattern.exec(normalized);
  }

  // Layer 4: bare table prevention (excepto CTE aliases y keywords reservadas)
  const cteAliases = new Set<string>();
  const ctePattern = /\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\b/gi;
  let cteMatch: RegExpExecArray | null;
  cteMatch = ctePattern.exec(normalized);
  while (cteMatch !== null) {
    cteAliases.add((cteMatch[1] ?? '').toLowerCase());
    cteMatch = ctePattern.exec(normalized);
  }

  const bareTablePattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_]\w*)\b(?!\s*\.)/gi;
  let bareMatch: RegExpExecArray | null;
  bareMatch = bareTablePattern.exec(normalized);
  while (bareMatch !== null) {
    const tableName = bareMatch[1] ?? '';
    const lower = tableName.toLowerCase();
    if (!SQL_KEYWORDS_BEFORE_TABLE.has(lower) && !cteAliases.has(lower)) {
      return {
        valid: false,
        error: `Table '${tableName}' must be schema-qualified. Use '${allowedSchema}.${tableName}' instead`,
      };
    }
    bareMatch = bareTablePattern.exec(normalized);
  }

  // Layer 5: dangerous functions
  if (DANGEROUS_FUNCTIONS.test(normalized)) {
    return { valid: false, error: 'Dangerous database function detected' };
  }

  return { valid: true };
}
