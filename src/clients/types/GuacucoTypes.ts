// ============================================================================
// Identity resolve — POST /identity/resolve
// ============================================================================

export interface ResolveIdentityInput {
  channelType: string;
  channelId: string;
  phoneNumberId?: string;
  userName?: string;
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
}

// ============================================================================
// Tool execute — POST /api/v1/tools/execute
// ============================================================================

export interface ToolExecuteRequest {
  tool_name: string;
  parameters: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** Opt-in idempotency (spec P1). Only honored for write tools. */
  idempotency_key?: string;
}

export interface ToolExecuteResponse<R = unknown> {
  tool_name: string;
  result: R;
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
