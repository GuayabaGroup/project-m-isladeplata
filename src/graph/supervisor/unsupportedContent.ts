import type { InboundContentType } from '../../core/enums/InboundContentType.js';
import type { Outcome } from '../../core/types/Outcome.js';

/**
 * Tipos de contenido que el agente puede procesar conversacionalmente. Los
 * demás (image/audio/video/document/location) se transportan en el
 * `ChannelMessage` pero el grafo no los entiende todavía.
 */
const SUPPORTED: ReadonlySet<InboundContentType> = new Set<InboundContentType>([
  'text',
  'interactive',
  'template_button',
]);

const UNSUPPORTED_REPLY =
  'Por ahora solo puedo procesar mensajes de texto. Todavía no proceso imágenes, audios, videos, documentos ni ubicaciones.';

/**
 * Fast-path determinístico (sin LLM): si el contenido entrante no es
 * procesable, devuelve un `Outcome` con respuesta canned para que el usuario
 * no quede en silencio. Retorna `null` para contenido soportado (sigue el
 * flujo normal del supervisor). §9-clean: no produce datos críticos.
 */
export function detectUnsupportedContent(contentType: InboundContentType): Outcome | null {
  if (SUPPORTED.has(contentType)) return null;
  return { action: 'response', pendingReply: { text: UNSUPPORTED_REPLY } };
}
