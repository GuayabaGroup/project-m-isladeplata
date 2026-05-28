/**
 * Prompts del QueryJudge (LLM-as-a-Judge para freeform_sql). Port adaptado de
 * IDP_OV1 (`prompts/judge-sql.ts` + `judge-synthesis.ts`), pero SIN el
 * `EvaluationContext` serializado a XML: isladeplata no tiene esa infra, así
 * que el contexto se arma como bloques de texto plano directamente desde los
 * args. Ambos prompts incluyen el historial reciente para resolver anáforas
 * ("¿y la próxima?", "¿de quién?") antes de rechazar.
 *
 * Ambos retornan JSON: {approved, confidence, critique, reason}.
 */

import type { ConversationTurn } from '../conversationHistory.js';

export interface JudgePrompt {
  system: string;
  user: string;
}

const SCHEMA_CHAR_CAP = 4000;
const ROWS_CHAR_CAP = 2000;

function historyBlock(history: ConversationTurn[] | undefined): string {
  if (!history || history.length === 0) return '(sin historial previo)';
  return history
    .map((t) => `[${t.role === 'user' ? 'USUARIO' : 'ASISTENTE'}]: ${t.content}`)
    .join('\n');
}

function rowsPreview(rows: ReadonlyArray<Record<string, unknown>>): string {
  try {
    return JSON.stringify(rows.slice(0, 10), null, 2).slice(0, ROWS_CHAR_CAP);
  } catch {
    return '[]';
  }
}

export interface SqlJudgeArgs {
  question: string;
  sql: string;
  schemaText: string;
  profileType: 'client' | 'staff';
  profileUuid: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  rowCount: number;
  history: ConversationTurn[] | undefined;
}

export function buildSqlJudgePrompt(args: SqlJudgeArgs): JudgePrompt {
  const system = `Sos un juez de validación de SQL. Tu trabajo es determinar si una query SQL generada responde correctamente la pregunta del usuario, cumple las reglas de seguridad obligatorias, y produjo resultados coherentes.

## Criterios de evaluación

1. **CORRECTITUD SEMÁNTICA**: ¿La SQL responde la pregunta real del usuario? Resolvé anáforas contra los turnos previos ANTES de rechazar (ej. "¿y la próxima?" hereda el sujeto del último turno del USUARIO; las respuestas del asistente — incluso negativas como "no tenés X" — NO redefinen el sujeto).

2. **COHERENCIA DE RESULTADOS**: ¿Los resultados tienen sentido? Columnas relevantes, valores plausibles, cantidad de filas razonable. Si hay 0 filas, distinguí lógica incorrecta de "no hay datos que coincidan".

3. **FILTRO OBLIGATORIO (SEGURIDAD CRÍTICA)**: La query DEBE filtrar por el perfil del usuario:
   - staff: \`staff_uuid = '${args.profileUuid}'\` o equivalente.
   - client: \`client_uuid = '${args.profileUuid}'\` o equivalente.
   Una query sin este filtro podría exponer datos de otros usuarios. Si falta → rechazá.

4. **ALINEACIÓN CON EL SCHEMA**: Todas las tablas/columnas referenciadas deben existir en el schema. Los JOINs deben ser correctos.

## Formato de respuesta
Respondé SOLO con un JSON válido, sin markdown ni explicación:
{"approved": true, "confidence": 0.9, "critique": "Análisis detallado", "reason": ""}
o
{"approved": false, "confidence": 0.8, "critique": "Análisis de los problemas", "reason": "Explicación breve en español"}`;

  const user = `PREGUNTA ACTUAL DEL USUARIO:
${args.question}

HISTORIAL RECIENTE (para resolver anáforas):
${historyBlock(args.history)}

IDENTIDAD: profile_type=${args.profileType}, profile_uuid=${args.profileUuid}

SQL GENERADA:
${args.sql}

RESULTADOS: row_count=${args.rowCount}
${rowsPreview(args.rows)}

SCHEMA DISPONIBLE:
${args.schemaText.slice(0, SCHEMA_CHAR_CAP)}

Evaluá la query SQL y sus resultados.`;

  return { system, user };
}

export interface SynthesisJudgeArgs {
  question: string;
  sql: string;
  synthesisText: string;
  rows: ReadonlyArray<Record<string, unknown>>;
  rowCount: number;
  history: ConversationTurn[] | undefined;
}

export function buildSynthesisJudgePrompt(args: SynthesisJudgeArgs): JudgePrompt {
  const system = `Sos un juez de precisión de datos. Tu trabajo es verificar que una respuesta sintetizada representa fielmente los resultados reales de la query, sin inventar datos.

## Criterios de evaluación

1. **FIDELIDAD DE DATOS**: ¿La síntesis contiene SOLO información presente en los resultados crudos? Cada número, fecha, nombre y dato debe trazarse a los datos crudos.

2. **SIN DATOS INVENTADOS**: Rechazá si hay números/conteos que no coinciden, fechas/horas ausentes en los resultados, nombres fabricados, o estadísticas no derivables.

   ### EXCEPCIÓN — QUERIES DE AGREGACIÓN (CRÍTICA)
   Cuando la SQL es una agregación (COUNT, SUM, AVG, MIN, MAX) que devuelve un valor agregado, la síntesis PUEDE usar un sustantivo en lenguaje natural derivado de un nombre de columna (presente en los rows O referenciado en la SQL) para describir ese valor. Esto es fiel, no inventado.
   Ejemplos APROBADOS:
   - raw: [{"total_agendamientos": 2}], síntesis: "Tenés 2 agendamientos este mes." ✓
   - raw: [{"sum_total": 1500}], SQL: \`SUM(amount) AS sum_total\`, síntesis: "El total es $1500." ✓
   Rechazá SOLO si el valor numérico difiere del crudo, o se introducen entidades (nombres/fechas) ausentes.

3. **COMPLETITUD**: ¿La síntesis cubre la información clave que responde la pregunta? Si la pregunta es anafórica, usá el historial para determinar qué pregunta realmente el usuario. Una síntesis que resuelve anáfora usando el turno previo como sujeto implícito NO es dato inventado, mientras cada valor concreto trace a los resultados.

4. **PRECISIÓN**: Cálculos (sumas, promedios, conteos) correctos según los datos crudos.

## Formato de respuesta
Respondé SOLO con un JSON válido, sin markdown ni explicación:
{"approved": true, "confidence": 0.9, "critique": "Análisis detallado", "reason": ""}
o
{"approved": false, "confidence": 0.8, "critique": "Discrepancias específicas encontradas", "reason": "Explicación breve en español"}`;

  const user = `PREGUNTA ORIGINAL DEL USUARIO:
${args.question}

HISTORIAL RECIENTE (para resolver anáforas):
${historyBlock(args.history)}

SQL EJECUTADA:
${args.sql}

RESULTADOS CRUDOS: row_count=${args.rowCount}
${rowsPreview(args.rows)}

RESPUESTA SINTETIZADA A EVALUAR:
${args.synthesisText}

Evaluá la respuesta sintetizada.`;

  return { system, user };
}
