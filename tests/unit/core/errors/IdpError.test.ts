import { describe, expect, it } from 'vitest';
import { IdentityNotFoundError } from '../../../../src/core/errors/IdentityNotFoundError.js';
import { IdpError } from '../../../../src/core/errors/IdpError.js';
import { RateLimitError } from '../../../../src/core/errors/RateLimitError.js';
import { ToolExecutionError } from '../../../../src/core/errors/ToolExecutionError.js';

describe('IdpError hierarchy', () => {
  it('IdpError carries code, message and details', () => {
    const err = new IdpError('invariant_violated', 'something is off', { where: 'commit' });
    expect(err.code).toBe('invariant_violated');
    expect(err.message).toBe('something is off');
    expect(err.details).toEqual({ where: 'commit' });
    expect(err.name).toBe('IdpError');
    expect(err).toBeInstanceOf(Error);
  });

  it('upstreamDeliveryFailure defaults to false and can be set explicitly', () => {
    expect(new IdpError('x', 'y').upstreamDeliveryFailure).toBe(false);
    const flagged = new IdpError('whatsapp_send_failed', 'boom', undefined, {
      upstreamDeliveryFailure: true,
    });
    expect(flagged.upstreamDeliveryFailure).toBe(true);
  });

  it('IdentityNotFoundError extends IdpError with fixed code', () => {
    const err = new IdentityNotFoundError();
    expect(err).toBeInstanceOf(IdpError);
    expect(err.code).toBe('identity_not_found');
    expect(err.name).toBe('IdentityNotFoundError');
  });

  it('IdentityNotFoundError preserves custom message and details', () => {
    const err = new IdentityNotFoundError('client not registered', { phone: 'masked' });
    expect(err.message).toBe('client not registered');
    expect(err.details).toEqual({ phone: 'masked' });
  });

  it('ToolExecutionError carries backend code verbatim', () => {
    const err = new ToolExecutionError('STAFF_NOT_AVAILABLE', 'slot taken', {
      staff_uuid: 'abc-123',
    });
    expect(err).toBeInstanceOf(IdpError);
    expect(err.code).toBe('STAFF_NOT_AVAILABLE');
    expect(err.details).toEqual({ staff_uuid: 'abc-123' });
  });

  it('RateLimitError has fixed code', () => {
    const err = new RateLimitError();
    expect(err).toBeInstanceOf(IdpError);
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.name).toBe('RateLimitError');
  });
});
