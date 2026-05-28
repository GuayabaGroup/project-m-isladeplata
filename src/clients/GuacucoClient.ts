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
  GetStaffAppointmentsSummaryParams,
  GetStaffAppointmentsSummaryResult,
  QueryProcessorExecuteResponse,
  QueryProcessorSchemaResponse,
  QueryProcessorTablesResponse,
  RescheduleAppointmentParams,
  RescheduleAppointmentResult,
  ResolveIdentityInput,
  ResolveIdentityOutput,
  ScheduleAppointmentParams,
  ScheduleAppointmentResult,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ValidateRescheduleSlotParams,
  ValidateRescheduleSlotResult,
} from './types/GuacucoTypes.js';

const RESOLVE_IDENTITY_PATH = '/identity/resolve';
const TOOL_EXECUTE_PATH = '/api/v1/tools/execute';
const QUERY_TABLES_PATH = '/api/v1/query-processor/tables';
const QUERY_EXECUTE_PATH = '/api/v1/query-processor/query';

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
   *
   * Es el único path para pre-validar un slot de schedule_appointment —
   * Guacuco no expone un `/tools/validate` separado; toda validación va por
   * executeTool con el handler correspondiente.
   */
  checkAvailability(params: CheckAvailabilityParams): Promise<CheckAvailabilityResult> {
    return this.executeTool<CheckAvailabilityResult>('check_availability', { ...params });
  }

  /**
   * Resumen de turnos del staff en un rango de fechas (max 31 días). Solo
   * staff role; Guacuco valida ownership via `context.profileUuid` +
   * `context.businessUuid` (los pasa el caller como ExecuteOptions.context).
   *
   * Devuelve `summary` pre-formateado por Guacuco + array de appointments
   * sin PII de cliente más allá del nombre. Si `date_end` se omite, Guacuco
   * usa `date_start` (1 día).
   */
  getStaffAppointmentsSummary(
    params: GetStaffAppointmentsSummaryParams,
    options: { profileUuid: string; businessUuid: string },
  ): Promise<GetStaffAppointmentsSummaryResult> {
    return this.executeTool<GetStaffAppointmentsSummaryResult>(
      'get_staff_appointments_summary',
      { ...params },
      {
        context: {
          profile_uuid: options.profileUuid,
          business_uuid: options.businessUuid,
          profile_type: 'staff',
        },
      },
    );
  }

  /**
   * Pre-check del slot pedido por el usuario para reagendar. Read-only.
   * Deriva staff/services del `appointment_uuid` (no los recibe en el input).
   *
   * Mandamos `date_hint=[oneDate]` + `time_hint='HH:mm'` para forzar el path
   * exact-match: si pasa, `passed=true` y `proposed_slots=[{date,time}]`;
   * si no, `passed=false` con alternativas en la ventana correspondiente.
   */
  validateRescheduleSlot(
    params: ValidateRescheduleSlotParams,
  ): Promise<ValidateRescheduleSlotResult> {
    return this.executeTool<ValidateRescheduleSlotResult>('validate_reschedule_slot', {
      ...params,
    });
  }

  // ==========================================================================
  // Query Processor (text-to-SQL, read-only)
  // ==========================================================================

  /**
   * Lista tablas disponibles para el rol del consultor. Guacuco filtra por
   * `profile_type` + `role_id` (staff requiere role_id, client lo omite).
   * Schema name viene como `"schema.table"` en `table_name`.
   */
  async getQueryTables(
    profileType: 'staff' | 'client',
    roleId?: number,
  ): Promise<QueryProcessorTablesResponse> {
    const params: Record<string, string | number> = { profile_type: profileType };
    if (roleId != null) params.role_id = roleId;
    const response = await this.http.get<Envelope<QueryProcessorTablesResponse>>(
      QUERY_TABLES_PATH,
      { params },
    );
    return this.unwrap<QueryProcessorTablesResponse>(response);
  }

  /**
   * Detalle de columnas (tipos, nullability, comments) + FKs de una tabla.
   * `tableName` es el nombre corto sin schema (Guacuco lo resuelve al espacio
   * permitido por el rol).
   */
  async getQueryTableSchema(
    tableName: string,
    profileType: 'staff' | 'client',
    roleId?: number,
  ): Promise<QueryProcessorSchemaResponse> {
    const params: Record<string, string | number> = { profile_type: profileType };
    if (roleId != null) params.role_id = roleId;
    const path = `${QUERY_TABLES_PATH}/${encodeURIComponent(tableName)}/schema`;
    const response = await this.http.get<Envelope<QueryProcessorSchemaResponse>>(path, {
      params,
    });
    return this.unwrap<QueryProcessorSchemaResponse>(response);
  }

  /**
   * Ejecuta SQL read-only. Guacuco enforce:
   * - keyword blocking (DANGEROUS_KEYWORD_DETECTED)
   * - read-only / write rejection (WRITE_OPERATION_NOT_ALLOWED)
   * - schema isolation por rol (SCHEMA_NOT_ALLOWED)
   * - max 5000 chars SQL
   * - information_schema bloqueado a nivel controller
   * - timeout configurable (default Guacuco)
   *
   * El caller (subgrafo query) hace validate previo local + maneja retry.
   */
  async executeQuery(
    sql: string,
    profileType: 'staff' | 'client',
    roleId?: number,
    timeout?: number,
  ): Promise<QueryProcessorExecuteResponse> {
    const body: Record<string, unknown> = { sql, profile_type: profileType };
    if (roleId != null) body.role_id = String(roleId);
    if (timeout != null) body.timeout = timeout;
    const response = await this.http.post<Envelope<QueryProcessorExecuteResponse>>(
      QUERY_EXECUTE_PATH,
      body,
    );
    return this.unwrap<QueryProcessorExecuteResponse>(response);
  }
}
