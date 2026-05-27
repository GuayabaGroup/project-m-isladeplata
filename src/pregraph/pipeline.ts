import type { Logger } from 'winston';
import type { MessageProcessor } from '../channels/ChannelAdapter.js';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { ParguitoClient } from '../clients/ParguitoClient.js';
import type { ResolveIdentityOutput } from '../clients/types/GuacucoTypes.js';
import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import type { CompiledGraph } from '../graph/compile.js';
import { captureIdpError } from '../infrastructure/observability/sentry.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
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
  logger: Logger;
}

/**
 * Pre-graph orchestrator (H3.A version). Pasos:
 *
 *   1. Dedup (Redis SET NX)
 *   2. Identity resolve (Guacuco) — IdentityNotFoundError → silent skip
 *   3. Welcome flow if `isNewUser` (staff auto-onboarded por Guacuco)
 *   4. Rate limit
 *   5. CRM context (Parguito stub, retorna defaults)
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
  private readonly logger: Logger;

  constructor(deps: PipelineDeps) {
    this.dedup = deps.dedup;
    this.rateLimit = deps.rateLimit;
    this.guacuco = deps.guacuco;
    this.parguito = deps.parguito;
    this.threadResolver = deps.threadResolver;
    this.graph = deps.graph;
    this.dispatcher = deps.dispatcher;
    this.logger = deps.logger;
  }

  async process(message: ChannelMessage): Promise<Outcome> {
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
        return { action: 'ignored' };
      }
      throw err;
    }

    // 3. Welcome flow para new staff (Guacuco auto-onboardea silenciosamente)
    if (identity.isNewUser) {
      const outcome = buildWelcomeOutcome(identity.welcomeMessage, identity.onboardingUrl);
      await this.dispatcher.dispatch(message, outcome);
      return outcome;
    }

    // 4. Invariantes pre-downstream
    const businessUuid = identity.businessStaffRoles?.business_uuid;
    const tenantAlliaId = identity.businessStaffRoles?.business_allia_id;
    const platformId = identity.businessStaffRoles?.platform_id;
    const profileUuid = identity.profileData.client_uuid ?? identity.profileData.staff_uuid;

    if (!businessUuid || !tenantAlliaId || !profileUuid || platformId == null) {
      this.logger.warn('Identity resolved but missing required fields', {
        hasBusiness: !!businessUuid,
        hasAlliaId: !!tenantAlliaId,
        hasProfile: !!profileUuid,
        hasPlatform: platformId != null,
      });
      return { action: 'ignored' };
    }

    const internalIdentity: Identity = {
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
      await this.dispatcher.dispatch(message, outcome);
      return outcome;
    }

    // 6. CRM context (stub Etapa 3 — defaults; en H3.B se augmenta con upcoming de identity)
    const crmContext = await this.parguito.getCrmContext(profileUuid);

    // 7. Thread management + Graph invoke
    const thread = await this.threadResolver.resolve(internalIdentity);
    this.logger.debug('Thread resolved', {
      thread_id: thread.threadId,
      has_active: thread.hasActiveCheckpoint,
      was_expired: thread.wasExpired,
    });

    const graphResult = await this.graph.invoke(
      {
        input: { channelMessage: message, receivedAt: message.receivedAt },
        identity: internalIdentity,
        crmContext,
      },
      { configurable: { thread_id: thread.threadId } },
    );

    const outcome: Outcome = graphResult.outcome ?? { action: 'ignored' };

    // 8. Dispatch
    await this.dispatcher.dispatch(message, outcome);
    return outcome;
  }
}
