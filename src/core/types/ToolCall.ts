/**
 * Registro neutral de una tool de Guacuco ejecutada por un subgrafo durante el
 * turno (schedule_appointment, cancel_appointment, etc.). Se acumula en
 * `subgraphState.meta.toolCalls`, el `finalize` lo propaga al `outcome`, y el
 * `ConversationPersister` lo mapea al shape de Guacuco (P2) para que dashboards
 * y soporte humano puedan auditar QUÉ hizo el bot contra el negocio, no solo qué
 * dijo. Vive en `core/` para que `Outcome` lo referencie sin depender de
 * `clients/` (el mapeo a `PersistAgentTurnToolCall` ocurre en el persister).
 */
export interface ToolCallRecord {
  toolName: string;
  /** Parámetros enviados a Guacuco (UUIDs/fechas; sin PII de texto libre). */
  input: unknown;
  resultStatus: 'ok' | 'error';
  /** Código de error de Guacuco cuando `resultStatus='error'`. */
  errorCode?: string;
}
