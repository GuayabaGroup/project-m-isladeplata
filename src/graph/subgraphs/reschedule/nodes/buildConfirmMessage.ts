import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import type { AnthropicProvider } from '../../../../infrastructure/llm/AnthropicProvider.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Genera el mensaje del gate de reagendamiento (LLM Haiku, max 120 tokens).
 *
 * Anti-alucinación: recibe SOLO `displayName` del appointment + nueva fecha+hora
 * de los slots resueltos. Sin UUIDs.
 *
 * Idempotente: si ya hay `intentUuid + message`, no-op (sobrevive re-runs).
 */

export interface RescheduleBuildConfirmDeps {
  llm: AnthropicProvider;
  logger: Logger;
}

const SYSTEM_PROMPT =
  'Sos un agente de atención al cliente. El usuario quiere REAGENDAR un turno (cambiar la fecha/hora). Generá UN mensaje (máx 2 oraciones) confirmando el cambio. Mencioná el turno original y la nueva fecha+hora. Terminá con "¿Confirmás?" o equivalente. NO inventes datos.';

const FALLBACK_TEMPLATE = (displayName: string, newDate: string, newTime: string) =>
  `Voy a reagendar "${displayName}" al ${formatDate(newDate)} a las ${newTime}. ¿Confirmás?`;

const SPANISH_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return date;
  return `${d} de ${SPANISH_MONTHS[m - 1] ?? ''}`;
}

export function makeRescheduleBuildConfirmMessageNode(deps: RescheduleBuildConfirmDeps) {
  const { llm, logger } = deps;

  return async function buildConfirm(state: {
    subgraphState?: unknown;
  }): Promise<Partial<RescheduleDraftState>> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) return {};

    if (current.confirmation.intentUuid && current.confirmation.message) {
      logger.debug('reschedule.buildConfirm: cached, skipping LLM');
      return {};
    }

    const { appointmentUuid, newDate, newTime } = current.slots;
    if (
      appointmentUuid.status !== 'resolved' ||
      newDate.status !== 'resolved' ||
      !newDate.value ||
      newTime.status !== 'resolved' ||
      !newTime.value
    ) {
      logger.warn('reschedule.buildConfirm: slots not resolved');
      return {};
    }
    const displayName = appointmentUuid.displayName ?? 'tu turno';

    const userPrompt = `Turno original: ${displayName}.\nNueva fecha: ${formatDate(newDate.value)} a las ${newTime.value}.\n\nGenerá el mensaje de confirmación.`;

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      maxTokens: 120,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const message =
      response.text.length > 0
        ? response.text
        : FALLBACK_TEMPLATE(displayName, newDate.value, newTime.value);
    const intentUuid = randomUUID();

    return {
      confirmation: {
        intentUuid,
        message,
        requestedAt: new Date().toISOString(),
      },
      phase: 'awaiting_confirmation',
    };
  };
}
