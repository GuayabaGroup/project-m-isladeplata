import type { Logger } from 'winston';
import { RESPONSE_CONFIG } from '../../../../config/llm.config.js';
import type { Outcome } from '../../../../core/types/Outcome.js';
import type { AnthropicProvider } from '../../../../infrastructure/llm/AnthropicProvider.js';
import type { AppointmentDraftState } from '../state.js';
import { formatDateForUser } from './buildConfirmMessage.js';

/**
 * Genera el mensaje de éxito post-commit. LLM Haiku, max 100 tokens, tono
 * cálido + confirmatorio.
 *
 * Anti-alucinación: SOLO displayName + fecha legible + hora. No `appointment_uuid`,
 * no UUIDs. Fallback determinístico si LLM falla.
 *
 * Pre-condición: `phase==='done'`. Set por `commit` en success path.
 */

export interface SuccessResponseDeps {
  llm: AnthropicProvider;
  logger: Logger;
}

const SYSTEM_PROMPT =
  'Sos un agente de atención al cliente. El turno se acaba de agendar correctamente. Generá UN mensaje de confirmación cálido, máximo 2 oraciones, en español. Mencioná servicio + persona + día + hora. NO inventes datos. NO menciones códigos internos.';

export function makeSuccessResponseNode(deps: SuccessResponseDeps) {
  const { llm, logger } = deps;

  return async function successResponse(state: {
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    if (!current) return {};

    const { services, staff, date, time } = current.slots;
    if (
      services.status !== 'resolved' ||
      staff.status !== 'resolved' ||
      date.status !== 'resolved' ||
      time.status !== 'resolved' ||
      !date.value ||
      !time.value
    ) {
      logger.warn('successResponse: slots not resolved (unexpected post-commit)');
      return {};
    }

    const summary = {
      services: services.displayName ?? 'tu reserva',
      staff: staff.displayName ?? 'el equipo',
      date: formatDateForUser(date.value),
      time: time.value,
    };

    const userPrompt = `Turno confirmado:
- Servicios: ${summary.services}
- Profesional: ${summary.staff}
- Fecha: ${summary.date}
- Hora: ${summary.time}

Generá el mensaje de confirmación al cliente.`;

    const response = await llm.complete({
      ...RESPONSE_CONFIG,
      maxTokens: 120,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text =
      response.text.length > 0
        ? response.text
        : `¡Listo! Agendé ${summary.services} con ${summary.staff} el ${summary.date} a las ${summary.time}. ¡Te esperamos!`;

    logger.debug('successResponse', { length: text.length, fallback: response.text.length === 0 });

    const terminalOutcome: Outcome = {
      action: 'response',
      pendingReply: { text },
    };
    return { terminalOutcome };
  };
}
