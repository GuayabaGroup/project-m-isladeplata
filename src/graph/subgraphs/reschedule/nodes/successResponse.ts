import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import type { RescheduleDraftState } from '../state.js';

/**
 * Mensaje de éxito post-reschedule. LLM Haiku corto. Recibe SOLO displayName
 * + nueva fecha+hora (sin UUIDs).
 */

export interface RescheduleSuccessDeps {
  llm: LlmProvider;
  logger: Logger;
}

const SYSTEM_PROMPT =
  'Sos un agente de atención al cliente. El usuario acaba de reagendar un turno. Generá UN mensaje corto (máx 2 oraciones) confirmando el cambio con la nueva fecha+hora. Tono amable. NO inventes datos. NO menciones códigos.';

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

export function makeRescheduleSuccessNode(deps: RescheduleSuccessDeps) {
  const { llm, logger } = deps;

  return async function successResponse(state: {
    subgraphState?: unknown;
  }): Promise<Partial<RescheduleDraftState>> {
    const current = state.subgraphState as RescheduleDraftState | undefined;
    if (!current) return {};

    const displayName = current.slots.appointmentUuid?.displayName ?? 'tu turno';
    const newDate = current.slots.newDate?.value;
    const newTime = current.slots.newTime?.value;
    const formattedDate = newDate ? formatDate(newDate) : 'la nueva fecha';
    const timePart = newTime ?? '';

    const userPrompt = `Turno reagendado: ${displayName}. Nueva fecha: ${formattedDate} a las ${timePart}. Generá el mensaje al cliente.`;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 100,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const fallback = `¡Listo! Reagendé "${displayName}" al ${formattedDate}${timePart ? ` a las ${timePart}` : ''}. ¡Te esperamos!`;
    const text = response.text.length > 0 ? response.text : fallback;

    logger.debug('reschedule.successResponse', {
      length: text.length,
      fallback: response.text.length === 0,
    });

    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text },
    };
    return { terminalOutcome };
  };
}
