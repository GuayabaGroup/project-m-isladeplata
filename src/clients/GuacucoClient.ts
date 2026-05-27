import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import { ToolExecutionError } from '../core/errors/ToolExecutionError.js';
import { BaseHttpClient } from './BaseHttpClient.js';
import type { Envelope } from './types/Envelope.js';
import type {
  CancelAppointmentParams,
  CancelAppointmentResult,
  CheckAvailabilityParams,
  CheckAvailabilityResult,
  ConfirmAppointmentParams,
  ConfirmAppointmentResult,
  RescheduleAppointmentParams,
  RescheduleAppointmentResult,
  ResolveIdentityInput,
  ResolveIdentityOutput,
  ScheduleAppointmentParams,
  ScheduleAppointmentResult,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolValidateRequest,
  ToolValidateRequestParam,
  ToolValidateResult,
} from './types/GuacucoTypes.js';

const RESOLVE_IDENTITY_PATH = '/identity/resolve';
const TOOL_EXECUTE_PATH = '/api/v1/tools/execute';
const TOOL_VALIDATE_PATH = '/api/v1/tools/validate';

export interface ExecuteOptions {
  context?: Record<string, unknown>;
  /** Opt-in idempotency for write tools (spec P1). */
  idempotencyKey?: string;
}

/**
 * HTTP client toward Guacuco (turnos, identity, tools execute/validate).
 *
 * Reglas (§6 REGLAS_ISLADEPLATA):
 * - Toda llamada va por `RetryClient` (inyectado).
 * - Envelope unwrap centralizado en `BaseHttpClient.unwrap`.
 * - `idempotency_key` se pasa solo a writes, top-level (no dentro de `parameters`).
 * - `resolveIdentity` traduce el upstream `USER_NOT_FOUND` a
 *   `IdentityNotFoundError` para que el pre-grafo lo distinga (silent skip).
 */
export class GuacucoClient extends BaseHttpClient {
  protected readonly errorPrefix = 'guacuco';

  // ==========================================================================
  // Identity
  // ==========================================================================

  /**
   * Resolve user identity from a channel. Returns the full identity payload
   * (catalog + business + appointments + welcome flow if applies).
   *
   * Throws `IdentityNotFoundError` when backend returns `USER_NOT_FOUND`
   * (client phone without business linkage — pre-grafo trata como silent skip).
   */
  async resolveIdentity(input: ResolveIdentityInput): Promise<ResolveIdentityOutput> {
    try {
      const response = await this.http.post<Envelope<ResolveIdentityOutput>>(
        RESOLVE_IDENTITY_PATH,
        {
          channelType: input.channelType,
          channelId: input.channelId,
          phoneNumberId: input.phoneNumberId,
          userName: input.userName,
        },
      );
      return this.unwrap<ResolveIdentityOutput>(response);
    } catch (err) {
      if (err instanceof ToolExecutionError && err.code === 'USER_NOT_FOUND') {
        throw new IdentityNotFoundError(err.message, err.details);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Tool execute (generic + per-tool wrappers)
  // ==========================================================================

  /**
   * Generic tool execute. Per-tool methods below are thin wrappers that pass
   * the correct `tool_name`. For writes, pass `idempotencyKey` (spec P1).
   */
  async executeTool<R>(
    toolName: string,
    parameters: Record<string, unknown>,
    options?: ExecuteOptions,
  ): Promise<R> {
    const body: ToolExecuteRequest = {
      tool_name: toolName,
      parameters,
    };
    if (options?.context) body.context = options.context;
    if (options?.idempotencyKey) body.idempotency_key = options.idempotencyKey;

    const response = await this.http.post<Envelope<ToolExecuteResponse<R>>>(
      TOOL_EXECUTE_PATH,
      body,
    );
    const wrapped = this.unwrap<ToolExecuteResponse<R>>(response);
    return wrapped.result;
  }

  scheduleAppointment(
    params: ScheduleAppointmentParams,
    options?: ExecuteOptions,
  ): Promise<ScheduleAppointmentResult> {
    return this.executeTool<ScheduleAppointmentResult>(
      'schedule_appointment',
      { ...params },
      options,
    );
  }

  cancelAppointment(
    params: CancelAppointmentParams,
    options?: ExecuteOptions,
  ): Promise<CancelAppointmentResult> {
    return this.executeTool<CancelAppointmentResult>('cancel_appointment', { ...params }, options);
  }

  rescheduleAppointment(
    params: RescheduleAppointmentParams,
    options?: ExecuteOptions,
  ): Promise<RescheduleAppointmentResult> {
    return this.executeTool<RescheduleAppointmentResult>(
      'reschedule_appointment',
      { ...params },
      options,
    );
  }

  confirmAppointment(
    params: ConfirmAppointmentParams,
    options?: ExecuteOptions,
  ): Promise<ConfirmAppointmentResult> {
    return this.executeTool<ConfirmAppointmentResult>(
      'confirm_appointment',
      { ...params },
      options,
    );
  }

  /**
   * Three modes (see CheckAvailabilityToolHandler in Guacuco):
   * - Mode A: date + time → validates specific slot + returns suggestions from that time
   * - Mode B: date only → returns all availability for that day
   * - Mode C: no date/time → returns availability from "now" onwards
   *
   * ALWAYS returns suggestions, even when the proposed slot is available.
   */
  checkAvailability(params: CheckAvailabilityParams): Promise<CheckAvailabilityResult> {
    return this.executeTool<CheckAvailabilityResult>('check_availability', { ...params });
  }

  // ==========================================================================
  // Tool validate (generic + per-tool wrappers)
  // ==========================================================================

  async validateTool(
    toolName: string,
    parameters: ToolValidateRequestParam[],
    context: Record<string, unknown>,
  ): Promise<ToolValidateResult> {
    const body: ToolValidateRequest = {
      tool_name: toolName,
      parameters,
      context,
    };
    const response = await this.http.post<Envelope<ToolValidateResult>>(TOOL_VALIDATE_PATH, body);
    return this.unwrap<ToolValidateResult>(response);
  }

  validateScheduleSlot(input: {
    date?: string;
    appointment_time?: string;
    business_allia_id: string;
    staff_uuid: string;
    service_uuids: string[];
  }): Promise<ToolValidateResult> {
    const params: ToolValidateRequestParam[] = [];
    if (input.date !== undefined) params.push({ name: 'date', value: input.date });
    if (input.appointment_time !== undefined) {
      params.push({ name: 'appointment_time', value: input.appointment_time });
    }
    return this.validateTool('schedule_appointment', params, {
      business_allia_id: input.business_allia_id,
      staff_uuid: input.staff_uuid,
      service_uuids: input.service_uuids,
    });
  }

  /**
   * Validate reschedule slot. Depends on spec P3 in Guacuco (unified validate
   * endpoint with `tool_name='reschedule_appointment'` + `appointment_uuid`
   * in context). Until P3 lands, this method targets the new endpoint and
   * will return validate errors if Guacuco hasn't deployed P3 yet.
   *
   * Key invariant: `appointment_uuid` in context lets Guacuco exclude the
   * own appointment from the availability calculation (so rescheduling to
   * the same slot is valid).
   */
  validateRescheduleSlot(input: {
    new_date?: string;
    new_time?: string;
    business_allia_id: string;
    staff_uuid: string;
    service_uuids: string[];
    appointment_uuid: string;
  }): Promise<ToolValidateResult> {
    const params: ToolValidateRequestParam[] = [];
    if (input.new_date !== undefined) params.push({ name: 'new_date', value: input.new_date });
    if (input.new_time !== undefined) params.push({ name: 'new_time', value: input.new_time });
    return this.validateTool('reschedule_appointment', params, {
      business_allia_id: input.business_allia_id,
      staff_uuid: input.staff_uuid,
      service_uuids: input.service_uuids,
      appointment_uuid: input.appointment_uuid,
    });
  }
}
