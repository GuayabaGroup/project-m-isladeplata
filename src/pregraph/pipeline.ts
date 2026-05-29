import { Command } from '@langchain/langgraph';
import * as Sentry from '@sentry/node';
import type { Logger } from 'winston';
import type { MessageProcessor } from '../channels/ChannelAdapter.js';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { ParguitoClient } from '../clients/ParguitoClient.js';
import type { HelpersListEntry, ResolveIdentityOutput } from '../clients/types/GuacucoTypes.js';
import { env } from '../config/env.js';
import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import { IdpError } from '../core/errors/IdpError.js';
import { type CatalogService, type CatalogState, EMPTY_CATALOG } from '../core/types/Catalog.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import {
  type CrmContext,
  EMPTY_CRM_CONTEXT,
  type UpcomingAppointment,
} from '../core/types/CrmContext.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { CompiledGraph } from '../graph/compile.js';
import type { ResumePayload } from '../graph/subgraphs/schedule/nodes/askSlot.js';
import {
  identityNotFoundTotal,
  pipelineLatencyMs,
  rateLimitHitTotal,
  roleProfileMismatchTotal,
  subgraphEnteredTotal,
  takeoverMutedTotal,
  turnProcessedTotal,
} from '../infrastructure/observability/metrics.js';
import { captureIdpError } from '../infrastructure/observability/sentry.js';
import { swallowAsync } from '../infrastructure/observability/swallowAsync.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
import type { TakeoverStore } from '../infrastructure/redis/TakeoverStore.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import type { ConversationPersister } from './ConversationPersister.js';
import type { ResponseDispatcher } from './ResponseDispatcher.js';
import type { TakeoverNotifier } from './TakeoverNotifier.js';
import type { ThreadResolver } from './ThreadResolver.js';
import { buildWelcomeOutcome } from './welcomeFlow.js';

export interface PipelineDeps {
  dedup: DedupStore;
  rateLimit: RateLimitStore;
  guacuco: GuacucoClient;
  parguito: ParguitoClient;
  threadResolver: ThreadResolver;
  graph: CompiledGraph;
  dispatcher: ResponseDispatcher;
  persister: ConversationPersister;
  takeover: TakeoverStore;
  takeoverNotifier: TakeoverNotifier;
  logger: Logger;
}

/**
 * Pre-graph orchestrator (H3.A version). Pasos:
 *
 *   1. Dedup (Redis SET NX)
 *   2. Identity resolve (Guacuco) — IdentityNotFoundError → silent skip
 *   3. Welcome flow if `isNewUser` (staff auto-onboarded por Guacuco)
 *   4. Rate limit
 *   5. CRM context (Parguito gated por env.PARGUITO_ENABLED — defaults si off)
 *   6. Thread management (compute thread_id + TTL inline)
 *   7. Graph invoke con identity + crmContext + channelMessage
 *   8. Dispatch outcome al channel sender
 *
 * Catch global → Sentry + dispatch error genérico. NEVER lets exceptions
 * bubble up al webhook handler.
 */
export class Pipeline implements MessageProcessor {
  private readonly dedup: DedupStore;
  private readonly rateLimit: RateLimitStore;
  private readonly guacuco: GuacucoClient;
  private readonly parguito: ParguitoClient;
  private readonly threadResolver: ThreadResolver;
  private readonly graph: CompiledGraph;
  private readonly dispatcher: ResponseDispatcher;
  private readonly persister: ConversationPersister;
  private readonly takeover: TakeoverStore;
  private readonly takeoverNotifier: TakeoverNotifier;
  private readonly logger: Logger;

  constructor(deps: PipelineDeps) {
    this.dedup = deps.dedup;
    this.rateLimit = deps.rateLimit;
    this.guacuco = deps.guacuco;
    this.parguito = deps.parguito;
    this.threadResolver = deps.threadResolver;
    this.graph = deps.graph;
    this.dispatcher = deps.dispatcher;
    this.persister = deps.persister;
    this.takeover = deps.takeover;
    this.takeoverNotifier = deps.takeoverNotifier;
    this.logger = deps.logger;
  }

  async process(message: ChannelMessage): Promise<Outcome> {
    const startNs = process.hrtime.bigint();
    const outcome = await Sentry.startSpan(
      {
        name: 'pipeline.process',
        op: 'pipeline',
        attributes: {
          'isladeplata.channel': message.channelType,
          'isladeplata.message_id': message.messageId,
        },
      },
      async () => this.runWithGlobalCatch(message),
    );
    const elapsedMs = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
    pipelineLatencyMs.labels({ outcome_action: outcome.action }).observe(elapsedMs);
    turnProcessedTotal
      .labels({ channel: message.channelType, outcome_action: outcome.action })
      .inc();
    return outcome;
  }

  private async runWithGlobalCatch(message: ChannelMessage): Promise<Outcome> {
    try {
      return await this.processInternal(message);
    } catch (err) {
      this.logger.error('Pipeline exception caught globally', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        messageId: message.messageId,
      });
      captureIdpError(err, {
        component: 'Pipeline.process',
        channelType: message.channelType,
        messageId: message.messageId,
      });
      const outcome: Outcome = {
        action: 'error',
        pendingReply: {
          text: 'Lo sentimos, tuvimos un problema técnico. Intentá de nuevo en un momento.',
        },
      };
      try {
        await this.dispatcher.dispatch(message, outcome);
      } catch (dispatchErr) {
        this.logger.warn('Error dispatch also failed', {
          error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
        });
      }
      return outcome;
    }
  }

  private async processInternal(message: ChannelMessage): Promise<Outcome> {
    // 1. Dedup
    if (await this.dedup.isDuplicate(message.channelType, message.messageId)) {
      return { action: 'ignored' };
    }

    // 2. Identity
    let identity: ResolveIdentityOutput;
    try {
      identity = await this.guacuco.resolveIdentity({
        channelType: message.channelType,
        channelId: message.channelId,
        // Hint de credencial opaco: el pre-grafo NO interpreta el valor, solo lo
        // reenvía. El contrato de Guacuco lo nombra `phone_number_id`.
        phoneNumberId: message.channelMeta?.phoneNumberId,
        userName: message.userName,
      });
    } catch (err) {
      if (err instanceof IdentityNotFoundError) {
        this.logger.info('Silent skip: client without business linkage', {
          channelType: message.channelType,
          messageId: message.messageId,
        });
        identityNotFoundTotal.labels({ channel: message.channelType }).inc();
        return { action: 'ignored' };
      }
      throw err;
    }

    // 3. Welcome flow para new staff (Guacuco auto-onboardea silenciosamente)
    if (identity.isNewUser) {
      const outcome = buildWelcomeOutcome(identity.welcomeMessage, identity.onboardingUrl);
      subgraphEnteredTotal.labels({ subgraph: 'welcome' }).inc();
      await this.dispatcher.dispatch(message, outcome);
      const welcomeIdentity = toInternalIdentityOrNull(identity, message);
      if (welcomeIdentity) {
        void this.persister.persistTurn(message, welcomeIdentity, outcome, {
          subgraph: 'welcome',
        });
      }
      return outcome;
    }

    // 4. Invariantes pre-downstream
    const internalIdentity = toInternalIdentityOrNull(identity, message);
    if (!internalIdentity) {
      this.logger.warn('Identity resolved but missing required fields', {
        hasBusiness: !!identity.businessStaffRoles?.business_uuid,
        hasAlliaId: !!identity.businessStaffRoles?.business_allia_id,
        hasProfile: !!(identity.profileData.client_uuid ?? identity.profileData.staff_uuid),
        hasPlatform: identity.businessStaffRoles?.platform_id != null,
      });
      return { action: 'ignored' };
    }
    // 4.1 Guard de coherencia rol↔perfil (fail-closed, §12.2 REGLAS). El rol de la
    // línea WhatsApp entrante (`channelMeta.role`) y el `profileType` resuelto por
    // Guacuco DEBEN coincidir — el número es por (plataforma, rol). Si divergen, la
    // línea de atención no corresponde al perfil resuelto: responderíamos desde una
    // línea (la del rol) procesando con tools/schema del otro rol → cruce de
    // información. Anomalía de seguridad ("no debería pasar" por §12.2): descartamos
    // el turno (silent skip, como identity-not-found) y lo dejamos visible en
    // logs/Sentry/métrica. Solo aplica a canales que portan `role` (WhatsApp).
    const inboundRole = message.channelMeta?.role;
    if (inboundRole && inboundRole !== internalIdentity.profileType) {
      this.logger.warn('Role/profileType mismatch — dropping turn (fail-closed)', {
        channelType: message.channelType,
        messageId: message.messageId,
        inboundRole,
        profileType: internalIdentity.profileType,
        platformId: internalIdentity.platformId,
      });
      captureIdpError(
        new IdpError(
          'role_profile_mismatch',
          'Inbound channel role does not match resolved profileType',
          {
            inboundRole,
            profileType: internalIdentity.profileType,
          },
        ),
        {
          component: 'Pipeline.processInternal',
          channelType: message.channelType,
          messageId: message.messageId,
        },
      );
      roleProfileMismatchTotal.labels({ channel: message.channelType }).inc();
      return { action: 'ignored' };
    }

    const { tenantUuid: businessUuid, profileUuid } = internalIdentity;
    const threadId = this.threadResolver.buildThreadId(internalIdentity);

    // 4.5 Takeover gate (spec P-human-takeover). Después de resolver identidad,
    // antes del rate-limit. Si un humano tomó la conversación, el bot calla: el
    // turno entrante se persiste (para que quede en el historial del dashboard)
    // pero no se genera respuesta. Lee el espejo Redis (rápido); el campo
    // `humanControlled` de Guacuco (cuando exista) lo repuebla/invalida sin
    // roundtrip extra.
    if (env.HUMAN_TAKEOVER_ENABLED) {
      await this.syncTakeoverMirror(threadId, identity.humanControlled);
      if (await this.takeover.isHumanControlled(threadId)) {
        const outcome: Outcome = { action: 'ignored' };
        void this.persister.persistTurn(message, internalIdentity, outcome);
        takeoverMutedTotal.labels({ channel: message.channelType }).inc();
        this.logger.info('Takeover gate: bot muted (human_controlled)', { thread_id: threadId });
        return outcome;
      }
    }

    // 5. Rate limit
    const rateResult = await this.rateLimit.checkLimit({
      tenantUuid: businessUuid,
      profileUuid,
      channel: message.channelType,
    });
    if (!rateResult.allowed) {
      const outcome: Outcome = {
        action: 'rate_limited',
        pendingReply: {
          text: 'Estás enviando muchos mensajes. Esperá un momento y volvé a intentarlo.',
        },
      };
      rateLimitHitTotal.labels({ channel: message.channelType }).inc();
      await this.dispatcher.dispatch(message, outcome);
      void this.persister.persistTurn(message, internalIdentity, outcome);
      return outcome;
    }

    // 6. CRM context. Parguito (gated por env.PARGUITO_ENABLED) aporta
    // profileMeta/historial; mientras esté en stub Etapa 3 el flag queda en
    // `false` y partimos de defaults sin roundtrip HTTP. Al habilitarse,
    // `ParguitoClient` es estricto y cualquier fallo cae al global catch.
    //
    // Los turnos próximos que consumen los bootstraps de confirm/cancel/
    // reschedule vienen SIEMPRE de Guacuco (source of truth de appointments,
    // ya resueltos en step 2 vía `profileData.appointments` — §7.1 paso 7), no
    // de Parguito: por eso `upcomingAppointments` se sobreescribe acá.
    const baseCrm = env.PARGUITO_ENABLED
      ? await this.parguito.getCrmContext(profileUuid)
      : EMPTY_CRM_CONTEXT;
    const crmContext: CrmContext = {
      ...baseCrm,
      upcomingAppointments: mapGuacucoAppointments(identity.profileData.appointments),
    };

    // 6.1 Catálogo (helpersLists del identity) — usado por H4 schedule subgrafo
    const catalog = buildCatalog(identity.helpersLists);

    // 7. Thread management + Graph invoke
    const thread = await this.threadResolver.resolve(internalIdentity);
    this.logger.debug('Thread resolved', {
      thread_id: thread.threadId,
      has_active: thread.hasActiveCheckpoint,
      was_expired: thread.wasExpired,
    });

    // 7.1 Detectar interrupts pendientes en este thread → invoke con Command(resume).
    // Si no hay interrupt, invoke fresh con el state completo.
    const pendingInterrupts = await this.detectPendingInterrupts(thread.threadId);

    const graphResult = await Sentry.startSpan(
      {
        name: 'pipeline.graph.invoke',
        op: 'graph.invoke',
        attributes: {
          'isladeplata.thread_id': thread.threadId,
          'isladeplata.resume': pendingInterrupts,
        },
      },
      async (): Promise<Awaited<ReturnType<CompiledGraph['invoke']>>> => {
        if (pendingInterrupts) {
          const resumePayload: ResumePayload = {
            text: sanitizeUserInput(message.contentText),
            ...(message.interactivePayload?.id ? { buttonId: message.interactivePayload.id } : {}),
          };
          this.logger.debug('Resuming graph with Command(resume)', {
            thread_id: thread.threadId,
            hasButton: !!resumePayload.buttonId,
          });
          return this.graph.invoke(new Command({ resume: resumePayload }), {
            configurable: { thread_id: thread.threadId },
          });
        }
        return this.graph.invoke(
          {
            input: { channelMessage: message, receivedAt: message.receivedAt },
            identity: internalIdentity,
            crmContext,
            catalog,
          },
          { configurable: { thread_id: thread.threadId } },
        );
      },
    );

    // Si el grafo se interrumpió en este turno, el outcome al usuario viene
    // del payload del interrupt (no del state.outcome — porque el nodo que
    // interrumpió no retornó).
    const outcome = this.outcomeFromResult(graphResult);

    // 8. Dispatch
    await this.dispatcher.dispatch(message, outcome);

    // 9. Persistencia turn-by-turn (fire-and-forget — spec P2).
    const subgraph = (graphResult as { routing?: { activeSubgraph?: string } }).routing
      ?.activeSubgraph;
    if (subgraph) subgraphEnteredTotal.labels({ subgraph }).inc();

    // 9.5 Takeover (spec P-human-takeover) — fire-and-forget, nunca bloquea.
    // Capas A/C dejan la señal en `outcome.takeover`; capa B la detecta el
    // contador de fallas. Todo gated por HUMAN_TAKEOVER_ENABLED.
    if (env.HUMAN_TAKEOVER_ENABLED) {
      void swallowAsync(
        this.logger,
        'takeover-postturn',
        this.handleTakeoverAfterTurn(
          internalIdentity,
          threadId,
          message,
          outcome,
          subgraph ?? null,
        ),
        { thread_id: threadId },
      );
    }

    void this.persister.persistTurn(message, internalIdentity, outcome, {
      ...(subgraph ? { subgraph } : {}),
      ...(outcome.toolCalls && outcome.toolCalls.length > 0
        ? { toolCalls: outcome.toolCalls }
        : {}),
    });
    return outcome;
  }

  private async detectPendingInterrupts(threadId: string): Promise<boolean> {
    try {
      const snapshot = await this.graph.getState({ configurable: { thread_id: threadId } });
      const tasks = snapshot?.tasks ?? [];
      return tasks.some((t) => Array.isArray(t.interrupts) && t.interrupts.length > 0);
    } catch (err) {
      this.logger.warn('detectPendingInterrupts failed (treating as no-resume)', {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Reconcilia el espejo Redis con el estado de takeover que reporta Guacuco en
   * `resolveIdentity` (spec P-human-takeover). Si Guacuco NO emite el campo (hoy,
   * endpoint bloqueado), no hace nada y el gate se rige solo por el espejo + TTL.
   * `active:true` repuebla el espejo (cubre restart/TTL perdido); `active:false`
   * lo invalida (reactivación humana desde el dashboard).
   */
  private async syncTakeoverMirror(
    threadId: string,
    humanControlled: ResolveIdentityOutput['humanControlled'],
  ): Promise<void> {
    if (!humanControlled) return;
    if (humanControlled.active) {
      await this.takeover.mirrorActive(threadId);
    } else {
      await this.takeover.clear(threadId);
    }
  }

  /**
   * Post-turno: dispara el takeover (capas A/C vía `outcome.takeover`, capa B vía
   * contador de fallas consecutivas) o resetea el contador en un outcome
   * exitoso. Fire-and-forget: corre dentro de `swallowAsync` y el notifier nunca
   * lanza, así que nunca bloquea el turno.
   */
  private async handleTakeoverAfterTurn(
    identity: Identity,
    threadId: string,
    message: ChannelMessage,
    outcome: Outcome,
    subgraph: string | null,
  ): Promise<void> {
    // Capas A/C: la señal vino adjunta al outcome (no cuenta como falla del bot).
    if (outcome.takeover) {
      await this.takeoverNotifier.trigger(
        identity,
        threadId,
        message,
        outcome.takeover.reasonCode,
        subgraph,
      );
      await this.takeover.resetFailures(threadId);
      return;
    }

    // Capa B: N salidas handed_off/error consecutivas → takeover.
    if (outcome.action === 'handed_off' || outcome.action === 'error') {
      const fails = await this.takeover.bumpFailures(threadId);
      if (fails >= env.TAKEOVER_FAILS_THRESHOLD) {
        await this.takeoverNotifier.trigger(
          identity,
          threadId,
          message,
          'repeated_failures',
          subgraph,
        );
        await this.takeover.resetFailures(threadId);
      }
    } else if (outcome.action === 'response' || outcome.action === 'awaiting_user') {
      // Outcome exitoso → resetea el contador de fallas.
      await this.takeover.resetFailures(threadId);
    }
  }

  private outcomeFromResult(graphResult: { outcome?: Outcome | null }): Outcome {
    // Si el grafo emitió __interrupt__ en este turno, el state.outcome no se
    // setea (el nodo que interrumpió no retornó). Pull del interrupt payload.
    const interrupts = (graphResult as { __interrupt__?: Array<{ value?: unknown }> })
      .__interrupt__;
    if (Array.isArray(interrupts) && interrupts.length > 0) {
      const first = interrupts[0]?.value as { pendingReply?: Outcome['pendingReply'] } | undefined;
      if (first?.pendingReply) {
        return { action: 'awaiting_user', pendingReply: first.pendingReply };
      }
    }
    return graphResult.outcome ?? { action: 'ignored' };
  }
}

/**
 * Construye el `Identity` interno desde `ResolveIdentityOutput`. Retorna
 * `null` si falta cualquier invariante crítico (business, allia_id, profile,
 * platform). El caller decide qué hacer: silent skip (ignored) o persistir
 * fallback (welcome flow).
 */
function toInternalIdentityOrNull(
  identity: ResolveIdentityOutput,
  message: ChannelMessage,
): Identity | null {
  const businessUuid = identity.businessStaffRoles?.business_uuid;
  const tenantAlliaId = identity.businessStaffRoles?.business_allia_id;
  const platformId = identity.businessStaffRoles?.platform_id;
  const profileUuid = identity.profileData.client_uuid ?? identity.profileData.staff_uuid;
  if (!businessUuid || !tenantAlliaId || !profileUuid || platformId == null) return null;
  return {
    tenantUuid: businessUuid,
    tenantAlliaId,
    profileUuid,
    profileType: identity.profileType,
    platformId,
    channel: message.channelType,
    timezone: identity.userTimezone,
    ...(identity.businessStaffRoles?.business_name
      ? { tenantName: identity.businessStaffRoles.business_name }
      : {}),
    ...(identity.businessStaffRoles?.role_id
      ? { roleId: identity.businessStaffRoles.role_id }
      : {}),
    ...(identity.businessStaffRoles?.agent_name
      ? { agentName: identity.businessStaffRoles.agent_name }
      : {}),
    ...(identity.businessStaffRoles?.business_country_code
      ? { countryCode: identity.businessStaffRoles.business_country_code }
      : {}),
  };
}

/**
 * Mapea `profileData.appointments` del identity resolve de Guacuco (source of
 * truth de turnos) al shape `UpcomingAppointment` que consumen los bootstraps
 * de confirm/cancel/reschedule. Guacuco no expone `startAt` en este payload, así
 * que el campo queda ausente (opcional en el tipo); los nodos que lo muestran ya
 * lo tratan como opcional. Filtra entradas sin `appointment_uuid`/`description`.
 */
function mapGuacucoAppointments(
  appointments: ResolveIdentityOutput['profileData']['appointments'],
): UpcomingAppointment[] {
  if (!appointments || appointments.length === 0) return [];
  return appointments
    .filter((a) => a?.appointment_uuid && a?.description)
    .map((a) => ({ appointmentUuid: a.appointment_uuid, description: a.description }));
}

/**
 * Normaliza `identity.helpersLists` (shape crudo de Guacuco con anidamiento)
 * a un `CatalogState` plano que el subgrafo schedule usa para fuzzy match
 * sin llamadas extra. Si la lista viene vacía o malformada, retorna catálogo
 * vacío en lugar de lanzar — el subgrafo trata catálogo vacío como "preguntar".
 */
function buildCatalog(helpersLists: HelpersListEntry[] | undefined): CatalogState {
  if (!helpersLists || helpersLists.length === 0) return EMPTY_CATALOG;
  const services: CatalogService[] = [];
  for (const entry of helpersLists) {
    const items = entry?.service_uuids?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item?.service_uuid || !item?.service_name) continue;
      services.push({
        uuid: item.service_uuid,
        name: item.service_name,
        description: item.description ?? null,
        price: item.price ?? null,
        staff: Array.isArray(item.staff_uuids)
          ? item.staff_uuids
              .filter((s) => s?.staff_uuid && s?.staff_name)
              .map((s) => ({ uuid: s.staff_uuid, name: s.staff_name }))
          : [],
      });
    }
  }
  return { services };
}
