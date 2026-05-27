import type { Logger } from 'winston';
import type { MessageProcessor } from '../channels/ChannelAdapter.js';
import type { GuacucoClient } from '../clients/GuacucoClient.js';
import type { ParguitoClient } from '../clients/ParguitoClient.js';
import type { ResolveIdentityOutput } from '../clients/types/GuacucoTypes.js';
import { IdentityNotFoundError } from '../core/errors/IdentityNotFoundError.js';
import type { ChannelMessage } from '../core/types/ChannelMessage.js';
import type { Identity } from '../core/types/Identity.js';
import type { Outcome } from '../core/types/Outcome.js';
import { captureIdpError } from '../infrastructure/observability/sentry.js';
import type { DedupStore } from '../infrastructure/redis/DedupStore.js';
import type { RateLimitStore } from '../infrastructure/redis/RateLimitStore.js';
import { type EchoResponder, buildWelcomeOutcome } from './EchoResponder.js';
import type { ResponseDispatcher } from './ResponseDispatcher.js';

export interface PipelineDeps {
  dedup: DedupStore;
  rateLimit: RateLimitStore;
  guacuco: GuacucoClient;
  parguito: ParguitoClient;
  echoResponder: EchoResponder;
  dispatcher: ResponseDispatcher;
  logger: Logger;
}

/**
 * Pre-graph orchestrator (H2 version): runs the deterministic pipeline
 * BEFORE the LangGraph compiled graph. Steps:
 *
 *   1. Dedup (Redis SET NX)
 *   2. Identity resolve (Guacuco) — IdentityNotFoundError → silent skip
 *   3. Welcome flow if `isNewUser` (staff auto-onboarded by Guacuco)
 *   4. Rate limit
 *   5. CRM context (Parguito, defaults if stub) — loaded for parity, not used in H2
 *   6. Echo response (H3 will replace with graph.invoke)
 *   7. Dispatch via channel sender
 *
 * The catch global emits Sentry + dispatches a generic error reply.
 * NEVER lets exceptions bubble up to the webhook handler.
 */
export class Pipeline implements MessageProcessor {
  private readonly dedup: DedupStore;
  private readonly rateLimit: RateLimitStore;
  private readonly guacuco: GuacucoClient;
  private readonly parguito: ParguitoClient;
  private readonly echoResponder: EchoResponder;
  private readonly dispatcher: ResponseDispatcher;
  private readonly logger: Logger;

  constructor(deps: PipelineDeps) {
    this.dedup = deps.dedup;
    this.rateLimit = deps.rateLimit;
    this.guacuco = deps.guacuco;
    this.parguito = deps.parguito;
    this.echoResponder = deps.echoResponder;
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

    // 4. Validar invariantes para llamadas downstream
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

    // 6. CRM context (fetch para validar wiring; en H3 alimenta el state global)
    await this.parguito.getCrmContext(profileUuid);

    // 7. Echo response (placeholder H2; H3 reemplaza con graph.invoke)
    const internalIdentity: Identity = {
      tenantUuid: businessUuid,
      tenantAlliaId,
      profileUuid,
      profileType: identity.profileType,
      platformId,
      channel: message.channelType,
      timezone: identity.userTimezone,
      ...(identity.businessStaffRoles?.role_id
        ? { roleId: identity.businessStaffRoles.role_id }
        : {}),
    };
    const outcome = this.echoResponder.build(message.contentText, internalIdentity);

    // 8. Dispatch
    await this.dispatcher.dispatch(message, outcome);
    return outcome;
  }
}
