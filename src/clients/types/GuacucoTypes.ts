import type { ProfileType } from '../../core/enums/ProfileType.js';
import type { TakeoverReasonCode } from '../../core/enums/TakeoverReason.js';

// ============================================================================
// Identity resolve — GET /api/v1/identity/resolve (snake_case query params)
// ============================================================================

export interface ResolveIdentityInput {
  channelType: string;
  channelId: string;
  phoneNumberId?: string;
  userName?: string;
}

/**
 * Raw shape returned by Guacuco's `GET /api/v1/identity/resolve` (snake_case
 * top-level). Confined to GuacucoClient + IdentityMapper; downstream uses
 * `ResolveIdentityOutput` (camelCase).
 */
export interface IdentityResolveRawResponse {
  user_uuid: string;
  user_name: string;
  user_phone: string;
  user_email?: string | null;
  user_timezone: string;
  user_language: string;
  profile_type: 'staff' | 'client';
  profile_data: {
    staff_uuid?: string;
    client_uuid?: string;
    appointments?: Array<{ appointment_uuid: string; description: string }>;
  };
  preferences: {
    working_hours: Array<{ day_of_week: string; hours: string }> | null;
  };
  business_staff_roles: BusinessStaffRoles | null;
  helpers_lists: HelpersListEntry[] | null;
  channel_data: {
    wa_id?: string;
    phone_number_id?: string;
    telegram_id?: string;
    device_id?: string;
  } | null;
  is_new_user: boolean;
  welcome_message?: string | null;
  onboarding_url?: string | null;
  /**
   * Estado de takeover humano del thread (spec P-human-takeover). OPCIONAL: hoy
   * Guacuco todavía no lo emite (endpoint/flag bloqueado). Cuando despliegue, el
   * pre-grafo lo usa para repoblar/invalidar el espejo Redis del gate.
   */
  human_controlled?: { active: boolean; expires_at?: string | null } | null;
}

export interface BusinessService {
  service_uuid: string;
  service_name: string;
  description: string | null;
  price: number | null;
  staffs: Array<{ staff_uuid: string; staff_name: string }>;
}

export interface BusinessStaffRoles {
  business_uuid: string;
  business_allia_id: string;
  business_name: string;
  business_summary: string | null;
  general_comments: string | null;
  platform_id: number | null;
  agent_name: string | null;
  business_country_code: string | null;
  staff_uuid: string;
  role: string;
  role_id: number;
  is_active: boolean;
  services: BusinessService[];
}

export interface HelpersListEntry {
  service_uuids: {
    items: Array<{
      service_uuid: string;
      service_name: string;
      description: string | null;
      price: number | null;
      staff_uuids: Array<{ staff_uuid: string; staff_name: string }>;
    }>;
  };
}

export interface ResolveIdentityOutput {
  userUuid: string;
  userName: string;
  userPhone: string;
  userEmail?: string;
  userTimezone: string;
  userLanguage: string;
  profileType: 'staff' | 'client';
  profileData: {
    staff_uuid?: string;
    client_uuid?: string;
    appointments?: Array<{ appointment_uuid: string; description: string }>;
  };
  preferences: {
    working_hours: Array<{ day_of_week: string; hours: string }> | null;
  };
  businessStaffRoles: BusinessStaffRoles | null;
  helpersLists: HelpersListEntry[];
  channelData: {
    wa_id?: string;
    phone_number_id?: string;
    telegram_id?: string;
    device_id?: string;
  } | null;
  isNewUser: boolean;
  welcomeMessage: string | null;
  onboardingUrl: string | null;
  /**
   * Estado de takeover humano del thread (spec P-human-takeover). `undefined`
   * cuando Guacuco no emite el campo (no desplegado) → el gate se gobierna solo
   * por el espejo Redis + TTL. `active: true` repuebla el espejo; `active: false`
   * lo invalida (reactivación humana desde el dashboard).
   */
  humanControlled?: { active: boolean; expiresAt: string | null };
}

// ============================================================================
// Recent templates — GET /api/v1/template-send-log/recent (snake_case params)
// ============================================================================

/**
 * Input tipado para `getRecentTemplates`. El pre-grafo pasa el teléfono del
 * destinatario (`message.channelId`). `windowHours`/`limit` los acota Guacuco
 * (1..168 / 1..50); omitirlos usa los defaults del backend.
 */
export interface GetRecentTemplatesInput {
  recipientPhone: string;
  windowHours?: number;
  limit?: number;
  status?: 'sent' | 'all';
}

/** Raw shape de cada entrada del log (snake_case). Confinado al client + mapper. */
export interface RecentTemplateRaw {
  log_uuid: string;
  template_name: string;
  recipient_phone: string;
  user_type: string;
  lang_code: string;
  parameters: unknown[];
  channel_phone_number_id: string | null;
  meta_message_id: string | null;
  status: 'sent' | 'failed';
  source_component: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Envelope `data` de `GET /api/v1/template-send-log/recent`. */
export interface RecentTemplatesRawResponse {
  templates: RecentTemplateRaw[];
  count: number;
  window_hours: number;
}

// ============================================================================
// Tool execute — POST /api/v1/tools/execute
// ============================================================================

/**
 * Sobre de identidad canónico enviado en `context` de TODA tool execute.
 * Matchea exactamente las keys que Guacuco lee en `ToolMapper.toExecuteToolInput`
 * (`profile_uuid`, `profile_type`, `business_uuid`, `role_id`). Guacuco lo usa
 * como guard cross-business. Se construye SIEMPRE vía `toolContextFromIdentity`.
 *
 * `business_allia_id` NO va acá — Guacuco no lo lee de `context`; es un
 * `parameter` en las tools que lo requieren (schedule, check_availability,
 * resolve_client, retrieve_manzanillo_url).
 */
export interface ToolContext {
  profile_uuid: string;
  profile_type: ProfileType;
  business_uuid: string;
  role_id?: number;
}

export interface ToolExecuteRequest {
  tool_name: string;
  parameters: Record<string, unknown>;
  context?: ToolContext;
  /** Opt-in idempotency (spec P1). Only honored for write tools. */
  idempotency_key?: string;
}

export interface ToolExecuteResponse<R = unknown> {
  tool_name: string;
  result: R;
}

/**
 * Resultado común de las tools de sistema que devuelven un link
 * (retrieve_manzanillo_url, generate_verification_url, connect_mercado_pago).
 * Las atomic tools sólo consumen `url`.
 */
export interface ToolUrlResult {
  url: string;
  response_type?: string;
  message?: string;
}

// ============================================================================
// Per-tool params + results
// ============================================================================

// validate_reschedule_slot (legacy tool handler, invocado via executeTool).
// Schedule NO tiene un validate dedicado; se usa check_availability Mode A.
// get_staff_appointments_summary (read-only, solo staff): ver tipos al final.

// schedule_appointment

export interface ScheduleAppointmentParams {
  business_allia_id: string;
  date: string;
  appointment_time: string;
  client_uuid: string;
  staff_uuid: string;
  service_uuids: string[];
}

// resolve_client (find-or-create cliente por teléfono — usado cuando el staff
// agenda para un tercero y solo conoce teléfono/nombre, no el UUID).

export interface ResolveClientParams {
  business_allia_id: string;
  client_phone: string;
  client_name?: string;
}

export interface ResolveClientResult {
  client_uuid: string;
  name: string;
}

export interface StaffAssignment {
  staff_uuid: string;
  service_uuid: string;
  start: string;
  end: string;
  start_time_utc: string;
  end_time_utc: string;
}

export interface ScheduleAppointmentResult {
  response_type: 'text';
  message: string;
  appointment_uuid: string;
  business_uuid: string;
  client_uuid: string;
  appointment_date: string;
  start_time: string;
  end_time: string;
  status: number;
  staff_assignments: StaffAssignment[];
}

// cancel_appointment

export interface CancelAppointmentParams {
  appointment_uuid: string;
}

export interface CancelAppointmentResult {
  response_type: 'text';
  message: string;
  appointment_uuid: string;
  status: number;
}

// reschedule_appointment

export interface RescheduleAppointmentParams {
  appointment_uuid: string;
  new_date: string;
  new_time: string;
}

export type RescheduleAppointmentResult = ScheduleAppointmentResult;

// validate_reschedule_slot (read-only pre-check, derives staff+services del appointment).

export interface ValidateRescheduleSlotParams {
  appointment_uuid: string;
  /** client UUID (Guacuco lo usa para validar ownership del turno). */
  profile_uuid: string;
  /** Fechas YYYY-MM-DD que el usuario quiere probar. Mandamos 1 (la del usuario). */
  date_hint: string[];
  /** 'morning'|'afternoon'|'evening' o 'HH:mm'. Mandamos HH:mm exacto. */
  time_hint: string;
}

export interface ValidateRescheduleProposedSlot {
  date: string;
  time: string;
}

export type ValidateRescheduleFallback =
  | { kind: 'text'; message: string }
  | {
      kind: 'selection_list';
      slot_name: string;
      header: string;
      button_text: string;
      options: Array<{ id: string; title: string; description: string }>;
    };

export interface ValidateRescheduleSlotResult {
  /** true sólo si exact match al date+time pedido. false en todo el resto. */
  passed: boolean;
  /** Si passed=true: 1 slot (el exacto). Si passed=false con alternatives: hasta 10 slots. */
  proposed_slots: ValidateRescheduleProposedSlot[];
  appointment_uuid: string;
  service_duration_minutes: number;
  /** Solo presente cuando passed=false. */
  fallback?: ValidateRescheduleFallback;
}

// get_staff_appointments_summary (solo staff). Guacuco valida ownership con
// context.profileUuid + context.businessUuid; el cliente los pasa via
// `options.context`.

export interface GetStaffAppointmentsSummaryParams {
  date_start: string; // YYYY-MM-DD
  date_end?: string; // si omitido, Guacuco usa date_start (1 día)
}

export interface StaffSummaryAppointmentService {
  service_name: string;
  staff_name: string;
}

export interface StaffSummaryAppointment {
  appointment_uuid: string;
  appointment_date: string;
  start_time: string;
  end_time: string;
  status: number;
  client_name: string | null;
  services: StaffSummaryAppointmentService[];
}

export interface GetStaffAppointmentsSummaryResult {
  response_type: 'text';
  message: string;
  /** Texto pre-formateado por Guacuco (StaffAppointmentsSummaryFormatter). */
  summary: string;
  total: number;
  date_start: string;
  date_end: string;
  appointments: StaffSummaryAppointment[];
}

// ============================================================================
// Query Processor — text-to-SQL endpoints (read-only). Ports IDP_OV1 contract.
// GET /api/v1/query-processor/tables?profile_type=...&role_id=...
// GET /api/v1/query-processor/tables/:tableName/schema?profile_type=...&role_id=...
// POST /api/v1/query-processor/query  {sql, profile_type, role_id?, timeout?}
// ============================================================================

/** `table_name` viene en formato "schema.table" (ej. `front_sche_client.services`). */
export type QueryProcessorTablesResponse = Array<{
  table_name: string;
  table_comment: string | null;
  columns: Array<{ column_name: string; column_comment: string | null }>;
}>;

export interface QueryProcessorSchemaResponse {
  columns: Array<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_comment: string | null;
  }>;
  foreignKeys: Array<{
    column_name: string;
    foreign_table_name: string;
    foreign_column_name: string;
  }>;
}

export interface QueryProcessorExecuteResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
}

// ============================================================================
// Persist agent turns — POST /api/v1/conversations/agent-turns (spec P2)
// Fire-and-forget desde el agente al cierre del pipeline.
// Idempotente por (thread_id, turn_id, role) a nivel de tabla en Guacuco.
// ============================================================================

export interface PersistAgentTurnInteractivePayload {
  type: 'button' | 'list';
  id: string;
  title?: string;
}

export interface PersistAgentTurnToolCall {
  tool_name: string;
  input: unknown;
  result_status: 'ok' | 'error';
  error_code?: string;
}

export interface PersistAgentTurnUserMessage {
  role: 'user';
  content: string;
  received_at: string;
  metadata?: {
    message_id?: string;
    interactive_payload?: PersistAgentTurnInteractivePayload | null;
  };
}

export interface PersistAgentTurnAssistantMessage {
  role: 'assistant';
  content: string;
  sent_at: string;
  outcome_action?: string;
  subgraph?: string;
  tool_calls?: PersistAgentTurnToolCall[];
}

export type PersistAgentTurnMessage =
  | PersistAgentTurnUserMessage
  | PersistAgentTurnAssistantMessage;

export interface PersistAgentTurnsRequest {
  tenant_allia_id: string;
  thread_id: string;
  profile_uuid: string;
  profile_type: 'staff' | 'client';
  channel: string;
  platform_id: number;
  turn_id: string;
  turns: PersistAgentTurnMessage[];
}

export interface PersistAgentTurnsResponse {
  turn_id: string;
  persisted: boolean;
}

// ============================================================================
// Takeover humano (spec P-human-takeover)
// Fire-and-forget desde el agente al auto-detectar (capas A/B/C).
//
// Contrato INTERNO del agente (`TriggerTakeoverRequest`/`Result`): lo produce
// `TakeoverNotifier` con el vocabulario del agente (thread_id, reason_code…).
// `GuacucoClient.triggerTakeover` lo traduce al contrato REAL de Guacuco
// (`PATCH /api/v1/short-term-memory/conversations/support-mode`, ver
// `ToggleSupportMode*`), que es donde vive el feature de takeover/escalación
// fusionado (silencia el bot + notifica al negocio). Guacuco lo clavetea por
// (profile_uuid, context_code).
// ============================================================================

export interface TriggerTakeoverRequest {
  tenant_allia_id: string;
  /** Mismo `thread_id` del checkpointer / P2 — llave del estado de takeover. */
  thread_id: string;
  profile_uuid: string;
  profile_type: ProfileType;
  channel: string;
  platform_id: number;
  reason_code: TakeoverReasonCode;
  /** Subgrafo activo al disparar, o null. */
  subgraph: string | null;
  /** Texto corto determinístico (sin UUIDs, PII enmascarada). */
  summary: string;
  /** Último mensaje del cliente, enmascarado. */
  last_user_message: string;
  /** TTL de seguridad acordado; Guacuco lo aplica server-side. */
  ttl_seconds: number;
  /** Dedup server-side; candidato: `${thread_id}:${turn_id}`. */
  idempotency_key: string;
}

export interface TriggerTakeoverResult {
  takeover_id: string;
  /** `false` cuando ya había un takeover activo para ese `thread_id`. */
  created: boolean;
}

// ----------------------------------------------------------------------------
// Contrato REAL de Guacuco — PATCH /api/v1/short-term-memory/conversations/support-mode
// `support_mode=true` + `notify_support=true` silencia el bot y alerta al negocio.
// ----------------------------------------------------------------------------

export interface ToggleSupportModeRequest {
  profile_uuid: string;
  /** Canal del agente mapeado a `context_code` de Guacuco (ej. 'whatsapp'). */
  context_code: string;
  support_mode: boolean;
  /** 'system' cuando lo dispara la auto-detección del agente; 'staff' si es manual. */
  activated_by: 'system' | 'staff';
  notify_support?: boolean;
  customer_wa_id?: string;
  customer_name?: string;
  trigger_message?: string;
  escalation_reason?: string;
}

export interface ToggleSupportModeResponse {
  conversation_id: string;
  support_mode: boolean;
}

// confirm_appointment

export interface ConfirmAppointmentParams {
  appointment_uuid: string;
}

export interface ConfirmAppointmentResult {
  response_type: 'text';
  message: string;
  appointment_uuid: string;
  status: number;
}

// check_availability — three modes (date+time / date only / no filter)

export interface CheckAvailabilityParams {
  business_allia_id: string;
  staff_uuid: string;
  service_uuids: string[];
  /** Optional — present in Mode A and B. */
  date?: string;
  /** Optional — present only in Mode A. */
  appointment_time?: string;
}

export interface AvailabilitySuggestion {
  service_uuids: string[];
  staff_uuid: string;
  date: string;
  appointment_time: string;
  label: string;
}

export interface CheckAvailabilityResult {
  response_type: 'text';
  message: string;
  /** Only present in Mode A (date+time). */
  available?: boolean;
  date?: string;
  start_time?: string;
  end_time?: string;
  staff_uuid?: string;
  service_uuids?: string[];
  total_duration_minutes?: number;
  /** Only present when available=false in Mode A. */
  reason?: string;
  suggestions: {
    schedule_appointment: AvailabilitySuggestion[];
  };
}
