/**
 * Prompt para generación de SQL (freeform_sql). Port de IDP_OV1
 * `src/conversation/prompts/query-sql.ts`.
 *
 * Reglas heredadas:
 * - Información temporal inyectada (currentDate, dayOfWeek).
 * - Profile filter per-column (client_uuid o staff_uuid según rol).
 * - SOLO columnas marcadas DATO_LECTURA en comentarios del schema.
 * - Schema-qualified tables (allowedSchema).
 * - GROUP BY/ORDER BY rules.
 * - unaccent() para búsquedas en español.
 * - INTERVAL para aritmética de fechas; sin CURRENT_TIMESTAMP / NOW().
 * - Historial reciente para resolver ANÁFORAS ("¿y la próxima?", "el último")
 *   + DRILL-DOWN (imperativos cortos heredan WHERE+rango, ajustan SELECT).
 * - Output JSON estricto: {answerable: true, sql} o {answerable: false, reason}.
 */

import type { Identity } from '../../../../core/types/Identity.js';
import type { ConversationTurn } from '../conversationHistory.js';

export interface SqlGenerationPrompt {
  systemPrompt: string;
  userMessage: string;
}

export interface TemporalContext {
  currentDate: string; // YYYY-MM-DD
  currentTimestamp: string; // YYYY-MM-DD HH:mm:ss
  dayOfWeek: number; // 0=Lun … 6=Dom
}

function staffRoleLabel(roleId: number | null | undefined): string {
  if (roleId === 1) return 'Owner (dueño del negocio)';
  if (roleId === 2) return 'Profesional';
  if (roleId === 3) return 'Admin';
  return 'Staff';
}

export function buildSqlGenerationPrompt(
  question: string,
  schemaText: string,
  identity: Identity,
  allowedSchema: string,
  maxRows: number,
  temporal: TemporalContext,
  errorContext?: string,
  conversationHistory?: ConversationTurn[],
): SqlGenerationPrompt {
  const isClient = identity.profileType === 'client';
  const tenantName = identity.tenantName ?? 'el negocio';
  const cd = temporal.currentDate;
  const dow = temporal.dayOfWeek;
  const profileCol = isClient ? 'client_uuid' : 'staff_uuid';

  const profileFilterRule = isClient
    ? `Siempre filtrá por client_uuid en el WHERE cuando la tabla tenga client_uuid.
   - client_uuid: '${identity.profileUuid}'
   Es el UUID del PROPIO usuario. Cuando habla en primera persona ("tengo", "mis", "yo"), usá este UUID directamente.`
    : `Siempre filtrá por staff_uuid en el WHERE cuando la tabla tenga staff_uuid.
   - staff_uuid: '${identity.profileUuid}'
   Es el UUID del PROPIO staff. Cuando habla en primera persona ("tengo", "mis", "yo"), usá este UUID directamente.`;

  const identityBlock = isClient
    ? `CONTEXTO DE IDENTIDAD:
- Tipo de perfil: CLIENT (cliente del negocio)
- UUID del cliente: ${identity.profileUuid}
- Negocio: ${tenantName}`
    : `CONTEXTO DE IDENTIDAD:
- Tipo de perfil: STAFF
- Rol: ${staffRoleLabel(identity.roleId)}
- UUID del staff: ${identity.profileUuid}
- Negocio: ${tenantName}`;

  const firstPersonRule = isClient
    ? `REGLA - Primera persona:
"tengo", "mis", "yo", "me" → WHERE client_uuid = '${identity.profileUuid}'.
NO retornes {"answerable": false, "reason": "falta especificar el cliente"} en estos casos.`
    : `REGLA - Primera persona:
"tengo", "mis", "yo", "mis clientes" → WHERE staff_uuid = '${identity.profileUuid}'.
NO retornes {"answerable": false, "reason": "falta especificar staff/cliente"} en estos casos.`;

  // --- Historial reciente para resolver anáforas + drill-down ---
  // Sin este bloque, los follow-ups cortos ("¿y la próxima?", "dame detalles")
  // caen en answerable:false porque el LLM responde conversacionalmente en vez
  // de heredar el sujeto/rango del turno previo.
  const historyBlock =
    conversationHistory && conversationHistory.length > 0
      ? `HISTORIAL RECIENTE DE LA CONVERSACIÓN (para resolver referencias):
${conversationHistory
  .map((turn) => `[${turn.role === 'user' ? 'USUARIO' : 'ASISTENTE'}]: ${turn.content}`)
  .join('\n')}

REGLA DE REFERENCIAS (ANÁFORAS):
Si la PREGUNTA ACTUAL usa pronombres o determinantes que dependen del historial
("cuáles son", "esos", "ese", "el último", "los de antes", "¿y la próxima?",
"¿y en abril?", "¿y mañana?"), interpretá la pregunta heredando el SUJETO del
ÚLTIMO TURNO DEL USUARIO y SOLO cambiando el rango (tiempo/scope). Las
respuestas del ASISTENTE — incluso negativas ("no tenés X", "no hay Y",
"0 resultados") — NO redefinen ni invalidan el sujeto heredado; solo informan
el resultado previo y deben IGNORARSE al determinar el sujeto. Buscá hacia atrás
hasta el último turno del USUARIO y usá ESE como fuente del sujeto. Si el usuario
hablaba de sí mismo, el sujeto sigue siendo el usuario del CONTEXTO DE IDENTIDAD
(usá su ${profileCol} directamente). SIEMPRE generá SQL — no pidas aclaración.

Ejemplos:
- [USUARIO]: "¿cuántos turnos confirmados tengo esta semana?" → actual: "¿y la que viene?"
  ⇒ "¿cuántos turnos confirmados tengo la próxima semana?"
     WHERE ${profileCol} = '${identity.profileUuid}' AND status = 'confirmed' AND (rango próxima semana)
- [USUARIO]: "¿cuánto facturé en marzo?" → actual: "¿y en abril?"
  ⇒ heredar sujeto (usuario) + cambiar rango (marzo → abril).
- [USUARIO]: "¿cuántas citas tengo esta semana?" / [ASISTENTE]: "No tenés citas." → actual: "¿y la próxima?"
  ⇒ "¿cuántas citas tengo la próxima semana?" (el sujeto se hereda del USUARIO, NO de la negación del asistente).

DRILL-DOWN (mismo sujeto/rango, cambian las COLUMNAS proyectadas):
Si la PREGUNTA ACTUAL pide ATRIBUTOS/DETALLES de los mismos registros de la
consulta previa, usá la MISMA query base (mismo WHERE, mismo rango) pero
agregando columnas descriptivas al SELECT (staff name, servicio, fecha, hora,
status). NO cambies WHERE, rango ni sujeto — solo el SELECT.

PATRONES DE DRILL-DOWN (cuando el historial tiene una respuesta del asistente con
dato cuantitativo: "tenés N", "hay N", "N turnos"):
- Imperativos cortos: "dame detalles", "detalles", "contame", "mostrame", "más info".
- Fragmentos de columnas: "con quién", "a qué hora", "qué servicios", "qué clientes",
  "cuándo", "fechas", "horarios", "quién atiende".
- Combinaciones: "con quién y qué servicios", "fecha y hora", "sobre los N turnos".
Para cada uno, heredá sujeto+rango del último turno del USUARIO y proyectá las
columnas descriptivas pedidas sobre el MISMO WHERE.

Ejemplo drill-down:
- [USUARIO]: "¿cuántos agendamientos tengo este mes?" / [ASISTENTE]: "Tenés 2 este mes."
  actual: "decime con quién y qué servicios"
  ⇒ SELECT fecha, <staff_name>, <service_name> FROM ${allowedSchema}.<vista_turnos>
     WHERE ${profileCol} = '${identity.profileUuid}'
       AND fecha >= DATE_TRUNC('month', DATE '${cd}')
       AND fecha <  DATE_TRUNC('month', DATE '${cd}') + INTERVAL '1 month'
     ORDER BY fecha LIMIT ${maxRows}

PROHIBIDO responder {"answerable": false, "reason": "ambigua"} cuando el historial
contiene una consulta previa del USUARIO y la actual pide detalles/atributos sobre
esos mismos registros. En ese caso SIEMPRE regenerá SQL heredando el WHERE.`
      : '';

  // Pre-compute "esta/próxima semana" offsets (0=Lun … 6=Dom).
  const toNextMon = 7 - dow;
  const toNextSun = 13 - dow;
  const toThisSun = 6 - dow;

  const systemPrompt = `Sos un experto en PostgreSQL. Generás consultas SQL precisas, optimizadas y libres de errores.

REGLA CRÍTICA #1 — GROUP BY / ORDER BY
Si tu query tiene GROUP BY, TODA columna en ORDER BY DEBE:
  - Estar en el GROUP BY, O
  - Ser una función de agregación (SUM, COUNT, MIN, MAX, AVG)

${identityBlock}

${historyBlock ? `${historyBlock}\n\n` : ''}${firstPersonRule}

INFORMACIÓN TEMPORAL:
- Año actual: ${cd.slice(0, 4)}
- Fecha actual: ${cd}
- Timestamp actual (timezone ${identity.timezone}): ${temporal.currentTimestamp}
- Día de la semana actual: ${dow} (0=Lunes … 6=Domingo)

ESQUEMA DE BASE DE DATOS:
${schemaText}

REGLAS:
1. ${profileFilterRule}
2. ESTRICTO: Usá ÚNICAMENTE nombres exactos de tablas y columnas del esquema. NO inventes columnas. Si una columna no existe en el esquema, NO la uses.
3. Incluí LIMIT ${maxRows} por defecto.
4. Si la pregunta no es clara, devolvé {"answerable": false, "reason": "..."}. EXCEPCIONES — NO son ambiguas: (a) primera persona ("tengo", "mis", "yo") → usá el UUID propio; (b) anáfora corta ("¿y la próxima?", "¿y en abril?") con historial → heredá sujeto + nuevo rango (ver REGLA DE REFERENCIAS); (c) drill-down ("dame detalles", "con quién", "qué servicios") con respuesta previa cuantitativa → heredá WHERE+rango y proyectá columnas (ver DRILL-DOWN).
5. Si la pregunta no tiene relación con la BD, devolvé {"answerable": false, "reason": "..."}.
6. Si el usuario no indica un año, usá el año actual (${cd.slice(0, 4)}).
7. Para SELECT, usá solo columnas marcadas como DATO_LECTURA en comentarios del esquema. Las sin marca son internas/sistema.
8. NO uses DELETE, DROP, TRUNCATE, ALTER, INSERT, UPDATE, CREATE.
9. TODAS las referencias a tablas DEBEN incluir el prefijo del esquema '${allowedSchema}.'. NUNCA uses tablas sin schema.
10. NUNCA uses columnas que no aparezcan explícitamente en el esquema. Si necesitás un dato que no está, devolvé {"answerable": false}.

REGLAS DE POSTGRESQL:

1. BÚSQUEDA DE TEXTO ESPAÑOL: usá unaccent() en AMBOS lados + LOWER().
   WHERE unaccent(LOWER(nombre)) ILIKE unaccent(LOWER('%maria%'))

2. FECHAS: usá DATE '${cd}' y TIMESTAMP '${temporal.currentTimestamp}'.
   NO uses CURRENT_TIMESTAMP, NOW(), CURRENT_DATE.

3. ARITMÉTICA DE FECHAS:
   DATE '${cd}' + INTERVAL '7 days'
   DATE '${cd}' + 7 * INTERVAL '1 day'
   (7 - EXTRACT(DOW FROM fecha))::integer * INTERVAL '1 day'
   NO sumes números directos a DATE.
   SIEMPRE casteá EXTRACT a ::integer antes de multiplicar por INTERVAL.

4. PERÍODOS:
   "HOY" = DATE '${cd}'
   "ESTA SEMANA" = WHERE fecha >= DATE '${cd}' AND fecha <= DATE '${cd}' + ${toThisSun} * INTERVAL '1 day'
   "PRÓXIMA SEMANA" = WHERE fecha >= DATE '${cd}' + ${toNextMon} * INTERVAL '1 day' AND fecha <= DATE '${cd}' + ${toNextSun} * INTERVAL '1 day'
   "ESTE MES" = WHERE fecha >= DATE_TRUNC('month', DATE '${cd}') AND fecha < DATE_TRUNC('month', DATE '${cd}') + INTERVAL '1 month'

FORMATO DE RESPUESTA OBLIGATORIO:
Respondé ÚNICAMENTE con un JSON válido:
{"answerable": true, "sql": "SELECT ... FROM ${allowedSchema}.tabla WHERE ..."}

Si no se puede generar una consulta válida:
{"answerable": false, "reason": "Explicación breve en español"}`;

  let userMessage = question;
  if (errorContext) {
    userMessage += `\n\n${errorContext}`;
  }
  return { systemPrompt, userMessage };
}

/** Computa el contexto temporal en la timezone del usuario. */
export function buildTemporalContext(timezone: string, now: Date = new Date()): TemporalContext {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    const currentDate = `${get('year')}-${get('month')}-${get('day')}`;
    const currentTimestamp = `${currentDate} ${get('hour')}:${get('minute')}:${get('second')}`;
    const jsDay = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
      now,
    );
    const dayMap: Record<string, number> = {
      Mon: 0,
      Tue: 1,
      Wed: 2,
      Thu: 3,
      Fri: 4,
      Sat: 5,
      Sun: 6,
    };
    const dayOfWeek = dayMap[jsDay] ?? 0;
    return { currentDate, currentTimestamp, dayOfWeek };
  } catch {
    const currentDate = now.toISOString().slice(0, 10);
    const currentTimestamp = now.toISOString().slice(0, 19).replace('T', ' ');
    const jsDay = now.getUTCDay();
    const dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;
    return { currentDate, currentTimestamp, dayOfWeek };
  }
}
