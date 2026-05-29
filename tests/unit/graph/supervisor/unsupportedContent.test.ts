import { describe, expect, it } from 'vitest';
import { detectUnsupportedContent } from '../../../../src/graph/supervisor/unsupportedContent.js';

describe('detectUnsupportedContent', () => {
  it('returns null for supported content types', () => {
    expect(detectUnsupportedContent('text')).toBeNull();
    expect(detectUnsupportedContent('interactive')).toBeNull();
    expect(detectUnsupportedContent('template_button')).toBeNull();
  });

  it('returns a canned response Outcome for media/location types', () => {
    for (const type of ['image', 'audio', 'video', 'document', 'location'] as const) {
      const outcome = detectUnsupportedContent(type);
      expect(outcome?.action).toBe('response');
      expect(outcome?.pendingReply?.text).toMatch(/solo puedo procesar mensajes de texto/i);
    }
  });
});
