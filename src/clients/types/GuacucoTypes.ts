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
// Tool validate — POST /api/v1/tools/validate
// ============================================================================

export interface ToolValidateRequestParam {
  name: string;
  value: string;
}

export interface ToolValidateRequest {
  tool_name: string;
  parameters: ToolValidateRequestParam[];
  context?: Record<string, unknown>;
}

export interface ToolValidateResultItem {
  name: string;
  valid: boolean;
  message: string | null;
}

export interface ToolValidateSuggestions {
  /** schedule_appointment validate */
  date?: string[];
  appointment_time?: string[];
  /** reschedule_appointment validate (P3) */
  new_date?: string[];
  new_time?: string[];
  /** Combined when both params fail simultaneously, format `YYYY-MM-DD HH:mm`. */
  combined?: string[];
}

export interface ToolValidateResult {
  valid: boolean;
  results: ToolValidateResultItem[];
  suggestions?: ToolValidateSuggestions;
}

// ============================================================================
// Per-tool params + results
// ============================================================================

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
