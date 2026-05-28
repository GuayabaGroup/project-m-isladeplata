import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { SUPERVISOR_CONFIG } from '../../../../config/llm.config.js';
import type { CatalogState } from '../../../../core/types/Catalog.js';
import type { LlmProvider } from '../../../../infrastructure/llm/LlmProvider.js';
import type { AppointmentDraftState } from '../state.js';

/**
 * Genera el mensaje confirmatorio (LLM Haiku) y el `intentUuid` del gate.
 *
 * Anti-alucinación (§9 REGLAS):
 * - El LLM recibe SOLO display names + valores ya renderizados (date legible
 *   en español, time HH:mm). NUNCA UUIDs.
 * - El `intentUuid` se genera con `randomUUID()` (no LLM).
 *
 * Idempotencia (gotcha LangGraph §5.3 PLAN_H4): si `confirmation.intentUuid`
 * ya existe en el state, NO regenera ni re-llama LLM. Esto cubre el caso de
 * resume tras interrupt en `gate_confirm` (que re-corre nodos previos en el
 * mismo super-step si el grafo está estructurado así; en nuestro wiring el
 * `gate_confirm` es nodo separado, pero la idempotencia es defensa en
 * profundidad).
 */

export interface BuildConfirmMessageDeps {
  llm: LlmProvider;
  logger: Logger;
}

const SYSTEM_PROMPT = `Sos un agente de atención al cliente que confirma turnos. Recibís un resumen del turno propuesto. Generá UN mensaje confirmatorio en español, máximo 2 oraciones, tono amable, conciso, terminando con "¿Confirmás?" o equivalente. NO inventes datos: usá SOLO lo que te paso. NO menciones UUIDs ni códigos internos.`;

const FALLBACK_MESSAGE = '¿Confirmás el turno?';

export function makeBuildConfirmMessageNode(deps: BuildConfirmMessageDeps) {
  const { llm, logger } = deps;

  return async function buildConfirmMessage(state: {
    catalog?: CatalogState;
    subgraphState?: AppointmentDraftState;
  }): Promise<Partial<AppointmentDraftState>> {
    const current = state.subgraphState;
    if (!current) return {};

    // Idempotencia: ya hay confirmación armada → no-op.
    if (current.confirmation.intentUuid && current.confirmation.message) {
      logger.debug('buildConfirmMessage: cached confirmation, skipping LLM');
      return {};
    }

    const summary = renderSummary(current, state.catalog ?? { services: [] });
    if (!summary) {
      logger.warn('buildConfirmMessage: slots not ready, cannot build summary');
      return {};
    }

    const userPrompt = `Resumen del turno:
- Servicios: ${summary.services}
- Profesional: ${summary.staff}
- Fecha: ${summary.date}
- Hora: ${summary.time}${summary.price ? `\n- Precio: ${summary.price}` : ''}${summary.clientName ? `\n- Cliente: ${summary.clientName}` : ''}

Generá el mensaje confirmatorio.`;

    const response = await llm.complete({
      ...SUPERVISOR_CONFIG,
      maxTokens: 160,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const message = response.text.length > 0 ? response.text : buildFallback(summary);
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

interface RenderedSummary {
  services: string;
  staff: string;
  date: string;
  time: string;
  price: string | null;
  clientName: string | null;
}

function renderSummary(
  state: AppointmentDraftState,
  catalog: CatalogState,
): RenderedSummary | null {
  const { services, staff, date, time, clientUuid } = state.slots;
  if (
    services.status !== 'resolved' ||
    staff.status !== 'resolved' ||
    date.status !== 'resolved' ||
    time.status !== 'resolved' ||
    !date.value ||
    !time.value
  ) {
    return null;
  }

  return {
    services: services.displayName ?? 'tu reserva',
    staff: staff.displayName ?? 'el equipo',
    date: formatDateForUser(date.value),
    time: time.value,
    price: computeTotalPrice(services.value, catalog),
    clientName: clientUuid?.status === 'guessed' ? (clientUuid.userPhrase ?? null) : null,
  };
}

const SPANISH_WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
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

export function formatDateForUser(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return ymd;
  // Construye fecha al mediodía UTC para evitar shift por timezone local.
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday = SPANISH_WEEKDAYS[dt.getUTCDay()] ?? '';
  const monthName = SPANISH_MONTHS[m - 1] ?? '';
  return `${weekday} ${d} de ${monthName}`.trim();
}

function computeTotalPrice(
  serviceUuids: string[] | undefined,
  catalog: CatalogState,
): string | null {
  if (!serviceUuids || serviceUuids.length === 0) return null;
  let total = 0;
  let anyPriced = false;
  for (const uuid of serviceUuids) {
    const svc = catalog.services.find((s) => s.uuid === uuid);
    if (svc?.price != null) {
      total += svc.price;
      anyPriced = true;
    }
  }
  if (!anyPriced) return null;
  return `$${total.toLocaleString('es-AR')}`;
}

function buildFallback(summary: RenderedSummary): string {
  return `Voy a agendar ${summary.services} con ${summary.staff} el ${summary.date} a las ${summary.time}. ${FALLBACK_MESSAGE}`;
}
