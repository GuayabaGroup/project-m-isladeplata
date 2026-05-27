import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { Logger } from 'winston';
import type { ChannelMessage } from '../../../src/core/types/ChannelMessage.js';
import { EMPTY_CRM_CONTEXT } from '../../../src/core/types/CrmContext.js';
import type { Identity } from '../../../src/core/types/Identity.js';
import { compileGraph } from '../../../src/graph/compile.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const IDENTITY: Identity = {
  tenantUuid: 'biz-1',
  tenantAlliaId: 'allia-1',
  profileUuid: 'prof-1',
  profileType: 'client',
  platformId: 1,
  channel: 'whatsapp',
  timezone: 'America/Argentina/Buenos_Aires',
};

function makeMessage(contentText: string): ChannelMessage {
  return {
    channelType: 'whatsapp',
    channelId: '54911000000',
    messageId: 'wamid.1',
    contentText,
    receivedAt: new Date().toISOString(),
    whatsappChannel: 'client',
    phoneNumberId: 'pn-1',
    interactivePayload: null,
  };
}

describe('compileGraph (echo node)', () => {
  it('returns a response outcome echoing the user text', async () => {
    const graph = compileGraph({ checkpointer: new MemorySaver(), logger: mockLogger });
    const result = await graph.invoke(
      {
        input: { channelMessage: makeMessage('hola mundo'), receivedAt: new Date().toISOString() },
        identity: IDENTITY,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'test-thread-1' } },
    );
    expect(result.outcome?.action).toBe('response');
    expect(result.outcome?.pendingReply?.text).toContain('hola mundo');
    expect(result.outcome?.pendingReply?.text).toContain('cliente');
  });

  it('uses staff label when profileType=staff', async () => {
    const graph = compileGraph({ checkpointer: new MemorySaver(), logger: mockLogger });
    const result = await graph.invoke(
      {
        input: { channelMessage: makeMessage('agenda hoy'), receivedAt: new Date().toISOString() },
        identity: { ...IDENTITY, profileType: 'staff' },
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'test-thread-staff' } },
    );
    expect(result.outcome?.pendingReply?.text).toContain('staff');
  });

  it('returns ignored when input is missing', async () => {
    const graph = compileGraph({ checkpointer: new MemorySaver(), logger: mockLogger });
    const result = await graph.invoke(
      { identity: IDENTITY, crmContext: EMPTY_CRM_CONTEXT },
      { configurable: { thread_id: 'test-thread-missing-input' } },
    );
    expect(result.outcome?.action).toBe('ignored');
  });

  it('persists state via checkpointer (different threads are isolated)', async () => {
    const checkpointer = new MemorySaver();
    const graph = compileGraph({ checkpointer, logger: mockLogger });
    await graph.invoke(
      {
        input: { channelMessage: makeMessage('A'), receivedAt: new Date().toISOString() },
        identity: IDENTITY,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'thread-A' } },
    );
    const resultB = await graph.invoke(
      {
        input: { channelMessage: makeMessage('B'), receivedAt: new Date().toISOString() },
        identity: IDENTITY,
        crmContext: EMPTY_CRM_CONTEXT,
      },
      { configurable: { thread_id: 'thread-B' } },
    );
    expect(resultB.outcome?.pendingReply?.text).toContain('B');
  });
});
