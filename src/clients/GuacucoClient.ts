import { AxiosError } from 'axios';
import { GUACUCO_TOOLS, type GuacucoToolName } from '../core/enums/GuacucoToolName.js';
import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import { IdpError } from '../core/errors/IdpError.js';
import { ToolExecutionError } from '../core/errors/ToolExecutionError.js';
import type { Identity } from '../core/types/Identity.js';
import { BaseHttpClient } from './BaseHttpClient.js';
import { mapRawToResolveIdentityOutput } from './mappers/IdentityMapper.js';
import { toolContextFromIdentity } from './mappers/ToolContextMapper.js';
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
  IdentityResolveRawResponse,
  PersistAgentTurnsRequest,
  PersistAgentTurnsResponse,
  QueryProcessorExecuteResponse,
  QueryProcessorSchemaResponse,
  QueryProcessorTablesResponse,
  RescheduleAppointmentParams,
  RescheduleAppointmentResult,
  ResolveClientParams,
  ResolveClientResult,
  ResolveIdentityInput,
  ResolveIdentityOutput,
  ScheduleAppointmentParams,
  ScheduleAppointmentResult,
  ToolContext,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolUrlResult,
  TriggerTakeoverRequest,
  TriggerTakeoverResult,
  ValidateRescheduleSlotParams,
  ValidateRescheduleSlotResult,
} from './types/GuacucoTypes.js';

const RESOLVE_IDENTITY_PATH = '/api/v1/identity/resolve';
const TOOL_EXECUTE_PATH = '/api/v1/tools/execute';
const QUERY_TABLES_PATH = '/api/v1/query-processor/tables';
const QUERY_EXECUTE_PATH = '/api/v1/query-processor/query';
const PERSIST_AGENT_TURNS_PATH = '/api/v1/conversations/agent-turns';
const TAKEOVER_PATH = '/api/v1/conversations/takeover';

/**
 * Opciones internas de `executeTool`. El `context` siempre se construye vía
 * `toolContextFromIdentity` dentro de los métodos tipados — los callers nunca
 * lo arman a mano.
 */
interface ExecuteOptions {
  context?: ToolContext;
  /** Opt-in idempotency for write tools (spec P1). */
  idempotencyKey?: string;
}

/** Opciones públicas de las tools de write (idempotencia opt-in, spec P1). */
export interface WriteToolOptions {
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
   * The real endpoint is `GET /api/v1/identity/resolve` with snake_case query
   * params (`channel_type`, `channel_id`, `phone_number_id?`, `user_name?`).
   * The raw response (snake_case top-level) is mapped to the camelCase
   * `ResolveIdentityOutput` via `IdentityMapper`.
   *
   * Throws `IdentityNotFoundError` when backend returns `USER_NOT_FOUND` or
   * HTTP 404 (client phone without business linkage — pre-grafo lo trata
   * como silent skip).
   */
  async resolveIdentity(input: ResolveIdentityInput): Promise<ResolveIdentityOutput> {
    try {
      const params: Record<string, string> = {
        channel_type: input.channelType,
        channel_id: input.channelId,
      };
      if (input.phoneNumberId) params.phone_number_id = input.phoneNumberId;
      if (input.userName) params.user_name = input.userName;

      const response = await this.http.get<Envelope<IdentityResolveRawResponse>>(
        RESOLVE_IDENTITY_PATH,
        { params },
      );
      const raw = this.unwrap<IdentityResolveRawResponse>(response);
      return mapRawToResolveIdentityOutput(raw);
    } catch (err) {
      if (err instanceof IdentityNotFoundError) throw err;
      if (err instanceof ToolExecutionError && err.code === 'USER_NOT_FOUND') {
        throw new IdentityNotFoundError(err.message, err.details);
      }
      if (err instanceof AxiosError && err.response?.status === 404) {
        throw new IdentityNotFoundError('Identity not found', {
          channelType: input.channelType,
          phoneNumberId: input.phoneNumberId,
        });
      }
      if (err instanceof IdpError) throw err;
      const ax = err as AxiosError;
      throw new ToolExecutionError(
        'guacuco_identity_error',
        ax.message ?? 'Guacuco identity/resolve failed',
        { status: ax.response?.status },
      );
    }
  }

  // ==========================================================================
  // Tool execute (generic + per-tool wrappers)
  // ==========================================================================

  /**
   * Dispatcher genérico hacia `POST /api/v1/tools/execute`. **Interno** — los
   * callers (commit nodes, atomic tools, subgrafos) usan los métodos tipados de
   * abajo, que arman el `context` uniforme vía `toolContextFromIdentity` y pasan
   * el `tool_name` desde `GUACUCO_TOOLS`. Ningún nodo del grafo arma `context` ni
   * conoce nombres de tool (§6 REGLAS).
   */
  protected async executeTool<R>(
    toolName: GuacucoToolName,
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
    identity: Identity,
    options?: WriteToolOptions,
  ): Promise<ScheduleAppointmentResult> {
    return this.executeTool<ScheduleAppointmentResult>(
      GUACUCO_TOOLS.SCHEDULE_APPOINTMENT,
      { ...params },
      { context: toolContextFromIdentity(identity), ...options },
    );
  }

  cancelAppointment(
    params: CancelAppointmentParams,
    identity: Identity,
    options?: WriteToolOptions,
  ): Promise<CancelAppointmentResult> {
    return this.executeTool<CancelAppointmentResult>(
      GUACUCO_TOOLS.CANCEL_APPOINTMENT,
      { ...params },
      { context: toolContextFromIdentity(identity), ...options },
    );
  }

  /**
   * Resuelve un cliente a su UUID a partir del teléfono (find-or-create). Lo usa
   * el subgrafo schedule cuando un staff agenda para un tercero y solo conoce
   * teléfono/nombre. Guacuco aplica el guard cross-business contra
   * `context.business_uuid` (write → BUSINESS_MISMATCH si no coincide).
   */
  resolveClient(params: ResolveClientParams, identity: Identity): Promise<ResolveClientResult> {
    return this.executeTool<ResolveClientResult>(
      GUACUCO_TOOLS.RESOLVE_CLIENT,
      { ...params },
      { context: toolContextFromIdentity(identity) },
    );
  }

  rescheduleAppointment(
    params: RescheduleAppointmentParams,
    identity: Identity,
    options?: WriteToolOptions,
  ): Promise<RescheduleAppointmentResult> {
    return this.executeTool<RescheduleAppointmentResult>(
      GUACUCO_TOOLS.RESCHEDULE_APPOINTMENT,
      { ...params },
      { context: toolContextFromIdentity(identity), ...options },
    );
  }

  confirmAppointment(
    params: ConfirmAppointmentParams,
    identity: Identity,
    options?: WriteToolOptions,
  ): Promise<ConfirmAppointmentResult> {
    return this.executeTool<ConfirmAppointmentResult>(
      GUACUCO_TOOLS.CONFIRM_APPOINTMENT,
      { ...params },
      { context: toolContextFromIdentity(identity), ...options },
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
   * executeTool con el handler correspondiente. Read-only.
   */
  checkAvailability(
    params: CheckAvailabilityParams,
    identity: Identity,
  ): Promise<CheckAvailabilityResult> {
    return this.executeTool<CheckAvailabilityResult>(
      GUACUCO_TOOLS.CHECK_AVAILABILITY,
      { ...params },
      { context: toolContextFromIdentity(identity) },
    );
  }

  /**
   * Resumen de turnos del staff en un rango de fechas (max 31 días). Solo
   * staff role; Guacuco valida ownership via `context.profile_uuid` +
   * `context.business_uuid` (vienen del context uniforme).
   *
   * Devuelve `summary` pre-formateado por Guacuco + array de appointments
   * sin PII de cliente más allá del nombre. Si `date_end` se omite, Guacuco
   * usa `date_start` (1 día).
   */
  getStaffAppointmentsSummary(
    params: GetStaffAppointmentsSummaryParams,
    identity: Identity,
  ): Promise<GetStaffAppointmentsSummaryResult> {
    return this.executeTool<GetStaffAppointmentsSummaryResult>(
      GUACUCO_TOOLS.GET_STAFF_APPOINTMENTS_SUMMARY,
      { ...params },
      { context: toolContextFromIdentity(identity) },
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
    identity: Identity,
  ): Promise<ValidateRescheduleSlotResult> {
    return this.executeTool<ValidateRescheduleSlotResult>(
      GUACUCO_TOOLS.VALIDATE_RESCHEDULE_SLOT,
      { ...params },
      { context: toolContextFromIdentity(identity) },
    );
  }

  // ==========================================================================
  // Atomic tools (sistema / support) — link generation + forward
  // ==========================================================================

  /**
   * Link público de booking (Manzanillo / front de cliente por plataforma).
   * Guacuco lee `parameters.business_allia_id` y aplica el guard cross-business
   * contra `context.business_uuid`.
   */
  retrieveManzanilloUrl(identity: Identity): Promise<ToolUrlResult> {
    return this.executeTool<ToolUrlResult>(
      GUACUCO_TOOLS.RETRIEVE_MANZANILLO_URL,
      { business_allia_id: identity.tenantAlliaId },
      { context: toolContextFromIdentity(identity) },
    );
  }

  /**
   * Link de verificación / acceso al panel. Guacuco lee `parameters.profile_uuid`
   * (el staff sujeto) y guarda contra `context.business_uuid`.
   */
  generateVerificationUrl(identity: Identity): Promise<ToolUrlResult> {
    return this.executeTool<ToolUrlResult>(
      GUACUCO_TOOLS.GENERATE_VERIFICATION_URL,
      { profile_uuid: identity.profileUuid },
      { context: toolContextFromIdentity(identity) },
    );
  }

  /**
   * Inicia el OAuth de Mercado Pago para el staff. Guacuco lee
   * `parameters.profile_uuid` y guarda contra `context.business_uuid`.
   */
  connectMercadoPago(identity: Identity): Promise<ToolUrlResult> {
    return this.executeTool<ToolUrlResult>(
      GUACUCO_TOOLS.CONNECT_MERCADO_PAGO,
      { profile_uuid: identity.profileUuid },
      { context: toolContextFromIdentity(identity) },
    );
  }

  /**
   * Reenvía al negocio un mensaje del usuario (ya resumido por la tool
   * `forward_message`). Guacuco resuelve el owner por `context.business_uuid` y
   * envía el template `p12_forward_support` por WhatsApp (handler
   * `ForwardMessageToolHandler`).
   */
  forwardMessage(originalMessage: string, identity: Identity): Promise<unknown> {
    return this.executeTool<unknown>(
      GUACUCO_TOOLS.FORWARD_MESSAGE,
      { original_message: originalMessage },
      { context: toolContextFromIdentity(identity) },
    );
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

  // ==========================================================================
  // Persistence — conversation turns (spec P2)
  // ==========================================================================

  /**
   * Persiste un turno del agente (user + opcional assistant) en Guacuco.
   * Idempotente por `(thread_id, turn_id, role)` a nivel de BD; reenvíos
   * del mismo `turn_id` retornan `persisted: false`.
   *
   * Llamado fire-and-forget desde `ConversationPersister`. Si Guacuco
   * responde error o el endpoint está caído, el caller swallowa: la
   * persistencia es analítica, NO bloquea el turno hacia el usuario.
   */
  async persistAgentTurns(payload: PersistAgentTurnsRequest): Promise<PersistAgentTurnsResponse> {
    const response = await this.http.post<Envelope<PersistAgentTurnsResponse>>(
      PERSIST_AGENT_TURNS_PATH,
      payload,
    );
    return this.unwrap<PersistAgentTurnsResponse>(response);
  }

  // ==========================================================================
  // Takeover humano (spec P-human-takeover)
  // ==========================================================================

  /**
   * Registra un takeover humano para un thread (`human_controlled`). Idempotente
   * por `(tenant_allia_id, idempotency_key)`: reenvíos retornan `created: false`
   * (mismo patrón de P1/P2). Guacuco aplica el `ttl_seconds` server-side.
   *
   * ⚠️ Pendiente backend: Guacuco NO expone hoy `POST /conversations/takeover`
   * (endpoint bloqueado en la spec). La llamada queda estandarizada del lado de
   * IDP; retornará error hasta que el endpoint exista. Por eso el caller
   * (`TakeoverNotifier`) la invoca fire-and-forget y NUNCA bloquea el turno.
   */
  async triggerTakeover(payload: TriggerTakeoverRequest): Promise<TriggerTakeoverResult> {
    const response = await this.http.post<Envelope<TriggerTakeoverResult>>(TAKEOVER_PATH, payload);
    return this.unwrap<TriggerTakeoverResult>(response);
  }
}
