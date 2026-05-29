/**
 * Tipos y helpers compartidos entre todos los subgrafos (`schedule`, `confirm`,
 * `cancel`, `reschedule`, `query`).
 *
 * Cada subgraph state DEBE incluir `__kind: SubgraphKind` como discriminador
 * para que el reducer de `subgraphState` rutee al merge correcto.
 */

import { IdpError } from '../../../core/errors/IdpError.js';
import { ToolExecutionError } from '../../../core/errors/ToolExecutionError.js';
import type { ToolCallRecord } from '../../../core/types/ToolCall.js';

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
  /** Tools de Guacuco ejecutadas en el turno (acumuladas por `mergeSubgraphMeta`). */
  toolCalls?: ToolCallRecord[];
}

/**
 * Merge canónico de `meta` para los reducers de subgrafo: `attempts` SUMA,
 * `recoverableErrors` y `toolCalls` APPEND. Centraliza la semántica que los 4
 * reducers de write compartían inline.
 */
export function mergeSubgraphMeta(
  current: SubgraphMeta,
  next?: Partial<SubgraphMeta>,
): SubgraphMeta {
  const merged: SubgraphMeta = {
    attempts: current.attempts + (next?.attempts ?? 0),
    recoverableErrors: [...current.recoverableErrors, ...(next?.recoverableErrors ?? [])],
  };
  const toolCalls = [...(current.toolCalls ?? []), ...(next?.toolCalls ?? [])];
  if (toolCalls.length > 0) merged.toolCalls = toolCalls;
  return merged;
}

/**
 * Agrega un `ToolCallRecord` al delta `meta` de un parcial retornado por un
 * nodo `commit_*`. El reducer luego appendea al acumulado del turno. Preserva
 * `attempts`/`recoverableErrors` que el parcial ya traiga.
 */
export function withToolCall<S extends { meta?: SubgraphMeta }>(
  partial: S,
  record: ToolCallRecord,
): S {
  const base: SubgraphMeta = partial.meta ?? { attempts: 0, recoverableErrors: [] };
  return {
    ...partial,
    meta: { ...base, toolCalls: [...(base.toolCalls ?? []), record] },
  };
}

/** Código de error de Guacuco si el error es un `ToolExecutionError`. */
export function toolCallErrorCode(err: unknown): string | undefined {
  return err instanceof ToolExecutionError ? err.code : undefined;
}

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
