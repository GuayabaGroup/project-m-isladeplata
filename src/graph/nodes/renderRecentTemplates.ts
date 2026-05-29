import { lookupTemplateContext } from '../../config/templateContext.config.js';
import type { RecentTemplate } from '../../core/types/RecentTemplate.js';

/**
 * Renderiza el contexto de templates proactivos recientes para inyectar en el
 * system prompt del supervisor (clasificador) y del social responder. Función
 * pura. Lista vacía → `''` (el caller no anexa nada).
 *
 * Guacuco NO persiste el body renderizado, solo `templateName` + `parameters`
 * (valores sustituidos), así que incluimos esos parámetros: le dan al LLM los
 * datos concretos (fecha, hora, servicio) a los que el usuario podría estar
 * respondiendo.
 *
 * Quién lo usa: `classifyIntent` y `socialResponder` (graph/supervisor).
 */

/** Cuántos templates renderizar como máximo (los más recientes primero). */
const MAX_RENDERED = 3;

export function renderRecentTemplatesContext(templates: RecentTemplate[]): string {
  if (!templates || templates.length === 0) return '';

  const lines = templates.slice(0, MAX_RENDERED).map((template, index) => {
    const entry = lookupTemplateContext(template.templateName);
    const description = entry?.description ?? `Mensaje automático "${template.templateName}".`;
    const params = renderParameters(template.parameters);
    const hint = entry?.suggestedIntentHint ? ` ${entry.suggestedIntentHint}` : '';
    const ordinal = index === 0 ? 'El más reciente' : `Anterior (${index + 1})`;
    return `- ${ordinal}: ${description}${params}${hint}`;
  });

  return `Mensajes automáticos (templates) que LE ENVIAMOS a este usuario recientemente, y a los que su mensaje actual podría estar respondiendo:
${lines.join('\n')}

Si el mensaje del usuario parece responder a uno de estos (ej. "sí", "dale", "confirmo", "no puedo", "cancelá"), interpretá su intención en ese contexto.`;
}

/** Extrae el texto de los parámetros del template ({type:'text', text}|string). */
function renderParameters(parameters: unknown[]): string {
  if (!Array.isArray(parameters) || parameters.length === 0) return '';
  const texts: string[] = [];
  for (const param of parameters) {
    if (typeof param === 'string') {
      if (param.length > 0) texts.push(param);
      continue;
    }
    if (param && typeof param === 'object' && 'text' in param) {
      const value = (param as { text?: unknown }).text;
      if (typeof value === 'string' && value.length > 0) texts.push(value);
    }
  }
  return texts.length > 0 ? ` Datos: ${texts.join(', ')}.` : '';
}
