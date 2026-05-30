/**
 * Vocabulario canónico de `tool_name` que Guacuco expone vía
 * `POST /api/v1/tools/execute`. Única fuente de verdad de los nombres de tool
 * consumidos desde isladeplata — reemplaza los string literals dispersos en
 * `GuacucoClient`, los commit nodes y las atomic tools.
 *
 * Vive en `core/` (sin dependencias) para que tanto `clients/` (dispatch real)
 * como `graph/` (registro del tool_call en el audit log) lo importen sin violar
 * la dirección de dependencias (§2 REGLAS — `graph/ → clients/` es solo por tipo).
 */
export const GUACUCO_TOOLS = {
  SCHEDULE_APPOINTMENT: 'schedule_appointment',
  CANCEL_APPOINTMENT: 'cancel_appointment',
  RESCHEDULE_APPOINTMENT: 'reschedule_appointment',
  CONFIRM_APPOINTMENT: 'confirm_appointment',
  CHECK_AVAILABILITY: 'check_availability',
  VALIDATE_RESCHEDULE_SLOT: 'validate_reschedule_slot',
  GET_STAFF_APPOINTMENTS_SUMMARY: 'get_staff_appointments_summary',
  SEND_CLIENT_SUMMARY: 'send_client_summary',
  RESOLVE_CLIENT: 'resolve_client',
  RETRIEVE_MANZANILLO_URL: 'retrieve_manzanillo_url',
  CONNECT_MERCADO_PAGO: 'connect_mercado_pago',
  FORWARD_MESSAGE: 'forward_message',
} as const;

export type GuacucoToolName = (typeof GUACUCO_TOOLS)[keyof typeof GUACUCO_TOOLS];
