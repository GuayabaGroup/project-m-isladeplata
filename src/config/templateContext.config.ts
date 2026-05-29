/**
 * Registry de templates proactivos conocidos → descripción legible + hint de
 * intent para el LLM. Cuando el usuario responde en texto libre a un template
 * (ej. recordatorio de turno), el supervisor usa esta descripción para
 * interpretar la respuesta (ver `renderRecentTemplatesContext`).
 *
 * El matching es por PREFIJO: los nombres reales tienen muchas variantes
 * (`p1_confirm_appointment_wservices_2`, `_8_staff`, `_wmobility`, …), así que
 * registramos la familia (`p1_confirm_appointment`) y no cada nombre exacto.
 * Nombres no registrados caen a un render genérico (nombre + parámetros).
 *
 * Centralizado acá (config/) como dato de referencia — NUNCA hardcodear estas
 * descripciones en nodos del grafo. Precedente: `config/personality/`.
 */
export interface TemplateContextEntry {
  /** Prefijos de `templateName` que matchean esta entrada (startsWith). */
  prefixes: readonly string[];
  /** Qué comunica el template, en lenguaje natural (se muestra al LLM). */
  description: string;
  /** Hint opcional de a qué suele responder el usuario. */
  suggestedIntentHint?: string;
}

export const TEMPLATE_CONTEXT_REGISTRY: readonly TemplateContextEntry[] = [
  {
    prefixes: ['p1_confirm_appointment', 'p2_confirm_appointment'],
    description: 'Pedido de confirmación de un turno (con fecha, hora y servicio).',
    suggestedIntentHint:
      'Si responde afirmativo ("sí", "dale", "confirmo", "ok") quiere CONFIRMAR el turno; si responde negativo ("no", "cancelá", "no puedo") quiere CANCELARLO.',
  },
  {
    prefixes: ['p5_appointment_reminder', 'p11_appointment_reminder'],
    description: 'Recordatorio de un turno próximo (con fecha, hora y servicio).',
    suggestedIntentHint:
      'El usuario suele confirmar asistencia, pedir cancelar, o reagendar a otro horario.',
  },
  {
    prefixes: ['p15_reschedule_appointment'],
    description: 'Aviso o propuesta de reagendado de un turno.',
    suggestedIntentHint:
      'La respuesta puede confirmar el nuevo horario o pedir otro (reagendar de nuevo).',
  },
  {
    prefixes: ['p10_cancel_appointment'],
    description: 'Aviso de que un turno fue cancelado.',
  },
  {
    prefixes: ['p7_daily_summary'],
    description: 'Resumen diario de los turnos del día (enviado al staff del negocio).',
  },
  {
    prefixes: ['p3_access'],
    description: 'Código de acceso / verificación para ingresar al panel.',
  },
  {
    prefixes: ['p12_forward_support'],
    description: 'Mensaje reenviado al equipo de soporte del negocio.',
  },
] as const;

/**
 * Busca la entrada del registry para un `templateName`. Normaliza un guion bajo
 * inicial (algunos nombres vienen como `_p7_daily_summary_3_appointment`).
 * Retorna `undefined` para nombres no registrados.
 */
export function lookupTemplateContext(templateName: string): TemplateContextEntry | undefined {
  const normalized = templateName.startsWith('_') ? templateName.slice(1) : templateName;
  return TEMPLATE_CONTEXT_REGISTRY.find((entry) =>
    entry.prefixes.some((prefix) => normalized.startsWith(prefix)),
  );
}
