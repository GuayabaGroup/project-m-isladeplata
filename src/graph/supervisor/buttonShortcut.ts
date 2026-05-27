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

export type ButtonShortcutKind = 'confirm' | 'cancel' | 'slot_pick' | 'service_pick' | 'staff_pick';

export interface ButtonShortcut {
  kind: ButtonShortcutKind;
  /** Para confirm/cancel/service_pick/staff_pick: el UUID. Para slot_pick: index numérico. */
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
