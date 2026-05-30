import type { InteractivePayload } from '../../core/types/ChannelMessage.js';

/**
 * Decisión determinística del supervisor para button payloads. Si el usuario
 * tocó un botón estructurado en WhatsApp (`confirm:<uuid>`, `cancel:<uuid>`,
 * `slot_pick:<idx>`, `service:<uuid>`, `staff:<uuid>`), bypasea el LLM y va
 * directo al subgrafo activo con un `resume`.
 *
 * Función pura. Retorna `null` cuando el payload no matchea ningún prefijo
 * conocido — el supervisor sigue al classifier LLM.
 */

export type ButtonShortcutKind =
  | 'confirm'
  | 'cancel'
  | 'reschedule'
  | 'slot_pick'
  | 'service_pick'
  | 'staff_pick';

export interface ButtonShortcut {
  kind: ButtonShortcutKind;
  /** Para confirm/cancel/reschedule/service_pick/staff_pick: el UUID. Para slot_pick: index numérico. */
  value: string | number;
}

const PREFIX_MAP: Record<string, ButtonShortcutKind> = {
  'confirm:': 'confirm',
  'cancel:': 'cancel',
  'slot_pick:': 'slot_pick',
  'service:': 'service_pick',
  'staff:': 'staff_pick',
};

export function detectButtonShortcut(payload?: InteractivePayload | null): ButtonShortcut | null {
  if (!payload || typeof payload.id !== 'string') return null;
  const id = payload.id;

  for (const [prefix, kind] of Object.entries(PREFIX_MAP)) {
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length);
      if (rest.length === 0) return null;
      if (kind === 'slot_pick') {
        const idx = Number.parseInt(rest, 10);
        if (Number.isNaN(idx) || idx < 0) return null;
        return { kind, value: idx };
      }
      return { kind, value: rest };
    }
  }

  return null;
}

/**
 * Detección para botones quick-reply de TEMPLATES de Guacuco (`contentType ===
 * 'template_button'`). A diferencia de los botones interactivos propios del IDP,
 * acá la ACCIÓN se deriva del `title` visible (lo que el usuario tocó), NO del
 * prefijo del payload: el payload se arma por POSICIÓN en Meta y un desalineo de
 * orden entre la plantilla aprobada y el mapeo por índice de Guacuco cruza la
 * acción (un botón "Cancelar cita" puede traer payload `confirm:<uuid>`). El uuid
 * SÍ es confiable y sale del payload (`<action>:<uuid>`).
 *
 * Si el título no matchea ninguna acción conocida, cae a `detectButtonShortcut`
 * (prefijo del payload) por robustez.
 */
const TITLE_ACTION_MAP: ReadonlyArray<{ re: RegExp; kind: ButtonShortcutKind }> = [
  { re: /cancelar/i, kind: 'cancel' },
  { re: /confirmar/i, kind: 'confirm' },
  { re: /reagendar|reprogramar/i, kind: 'reschedule' },
];

export function detectTemplateButtonShortcut(
  payload?: InteractivePayload | null,
): ButtonShortcut | null {
  if (!payload || typeof payload.id !== 'string') return null;

  const title = (payload.title ?? '').trim();
  const action = TITLE_ACTION_MAP.find(({ re }) => re.test(title));
  if (action) {
    const colon = payload.id.indexOf(':');
    const uuid = colon >= 0 ? payload.id.slice(colon + 1) : payload.id;
    if (uuid.length === 0) return null;
    return { kind: action.kind, value: uuid };
  }

  // Título no reconocido → fallback al ruteo por prefijo del payload.
  return detectButtonShortcut(payload);
}
