/**
 * Tipos y helpers compartidos entre todos los subgrafos (`schedule`, `confirm`,
 * `cancel`, `reschedule`, `query`).
 *
 * Cada subgraph state DEBE incluir `__kind: SubgraphKind` como discriminador
 * para que el reducer de `subgraphState` rutee al merge correcto.
 */

import { IdpError } from '../../../core/errors/IdpError.js';

export type SubgraphKind = 'schedule' | 'confirm' | 'cancel' | 'reschedule' | 'query';

export type SlotStatus = 'empty' | 'guessed' | 'resolved';

export interface SlotState<TValue> {
  value?: TValue;
  /** Texto crudo del usuario que originó el slot. */
  userPhrase?: string;
  /** Display name para mostrar al LLM. NUNCA UUIDs. */
  displayName?: string;
  status: SlotStatus;
}

export interface SubgraphMeta {
  attempts: number;
  recoverableErrors: string[];
}

export const EMPTY_META: SubgraphMeta = { attempts: 0, recoverableErrors: [] };

/**
 * Asserción genérica anti-alucinación: lanza `IdpError('invariant_violated')`
 * si alguno de los slots requeridos no está `resolved` con valor presente.
 * Cada subgrafo provee el `slots` typeado y la lista de keys requeridas.
 */
export function assertSlotsResolvedGeneric<S extends object>(
  slots: S,
  required: ReadonlyArray<keyof S & string>,
): void {
  for (const key of required) {
    const slot = (slots as Record<string, SlotState<unknown> | undefined>)[key];
    if (!slot) {
      throw new IdpError('invariant_violated', `Required slot missing: ${key}`);
    }
    if (slot.status !== 'resolved') {
      throw new IdpError('invariant_violated', `Slot ${key} not resolved before commit`, {
        slot: key,
        status: slot.status,
      });
    }
    if (slot.value === undefined || slot.value === null) {
      throw new IdpError('invariant_violated', `Slot ${key} resolved but value missing`, {
        slot: key,
      });
    }
  }
}
