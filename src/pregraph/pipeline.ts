import { Command } from '@langchain/langgraph';
import * as Sentry from '@sentry/node';
import type { Logger } from 'winston';
import type { MessageProcessor } from '../channels/ChannelAdapter.js';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { ParguitoClient } from '../clients/ParguitoClient.js';
import type { HelpersListEntry, ResolveIdentityOutput } from '../clients/types/GuacucoTypes.js';
import { env } from '../config/env.js';
import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import { type CatalogService, type CatalogState, EMPTY_CATALOG } from '../core/types/Catalog.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../core/types/CrmContext.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { CompiledGraph } from '../graph/compile.js';
import type { ResumePayload } from '../graph/subgraphs/schedule/nodes/askSlot.js';
import {
  identityNotFoundTotal,
  pipelineLatencyMs,
  rateLimitHitTotal,
  subgraphEnteredTotal,
  turnProcessedTotal,
} from '../infrastructure/observability/metrics.js';
import { captureIdpError } from '../infrastructure/observability/sentry.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
import { sanitizeUserInput } from '../security/sanitize.js';
import type { ConversationPersister } from './ConversationPersister.js';
import type { ResponseDispatcher } from './ResponseDispatcher.js';
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
        phoneNumberId: message.phoneNumberId,
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
    const { tenantUuid: businessUuid, profileUuid } = internalIdentity;

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

    // 6. CRM context — gated por env.PARGUITO_ENABLED. Mientras Parguito esté
    // en stub Etapa 3, el flag queda en `false` y pasamos defaults sin hacer
    // el roundtrip HTTP. Al habilitarse, `ParguitoClient` es estricto y
    // cualquier fallo cae al global catch del pipeline.
    const crmContext = env.PARGUITO_ENABLED
      ? await this.parguito.getCrmContext(profileUuid)
      : EMPTY_CRM_CONTEXT;

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
    void this.persister.persistTurn(message, internalIdentity, outcome, {
      ...(subgraph ? { subgraph } : {}),
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
  };
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
