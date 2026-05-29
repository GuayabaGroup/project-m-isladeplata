import type { ProfileType } from '../../core/enums/ProfileType.js';
import type { Identity } from '../../core/types/Identity.js';
import { getAccentInstruction } from './accentInstructions.js';
import { resolveAssistantName } from './assistantName.js';
import { buildAlliaPrompt, buildDivappPrompt, buildGroomiaPrompt } from './platformPersonas.js';

/**
 * Punto de entrada único de la personalidad del agente. Compone el bloque de
 * persona que se antepone (prepend) al prompt de tarea de cada nodo que genera
 * prosa al usuario, de modo que el agente suene como el MISMO personaje
 * (Ally/Groomy/Divy) independientemente del canal y del subgrafo/nodo que
 * responda.
 *
 * Quién lo usa: `supervisor/socialResponder` y los nodos `buildConfirmMessage`
 * / `successResponse` / `synthesizeResponse` de los subgrafos.
 *
 * Orden del bloque (decisión de diseño): persona de marca (con el nombre del
 * asistente resuelto) → regla de identidad del negocio → regla de formato de
 * respuesta → (opcional) disclosure de IA → instrucción de acento. El acento va
 * ÚLTIMO para que sus pronombres (voseo/tuteo) prevalezcan sobre cualquier
 * ejemplo de la persona.
 */

export interface PersonaContext {
  platformId: number;
  profileType: ProfileType;
  agentName: string | null;
  countryCode: string | null;
  businessName: string;
  /**
   * Notas y políticas operativas del negocio (`identity.businessGeneralComments`).
   * Se emite como bloque AUTORITATIVO `<business_policies_and_notes>`. `null`/
   * vacío → bloque omitido. Ver `Identity.businessGeneralComments`.
   */
  businessPolicies?: string | null;
}

export interface BuildPersonaOptions {
  /**
   * Incluye la regla de disclosure de identidad IA (no impersonar humanos;
   * aclararse si lo llaman por un nombre propio). Activar en nodos
   * conversacionales de texto libre (social, síntesis de queries) donde el
   * usuario puede dirigirse al asistente como si fuera una persona. Apagado en
   * nodos transaccionales (confirm/success) donde no aplica.
   */
  aiIdentityDisclosure?: boolean;
}

const DEFAULT_BUSINESS_NAME = 'el negocio';

/**
 * Regla de formato transversal a todas las marcas y canales. Gobierna el markup
 * y la escaneabilidad de la salida (qué resaltar, cuándo listar, cómo separar
 * ideas); el tono y los emojis siguen siendo responsabilidad de cada persona de
 * marca. Va dentro de `buildPersona` para que TODOS los nodos que generan prosa
 * lo hereden desde un único lugar (DRY). El markup es el NATIVO de WhatsApp
 * (asterisco simple = negrita), no markdown: el `ResponseBuilder` no convierte,
 * solo trunca, así que el LLM debe emitir el formato final tal cual.
 */
const RESPONSE_FORMATTING = `RESPONSE FORMATTING (WhatsApp): Make every reply easy to scan, using WhatsApp's native markup — NOT Markdown.
- Bold is *single asterisks*, italic is _single underscores_. NEVER use Markdown (**double asterisks**, # headers, tables) — WhatsApp renders it literally.
- Bold the key data the user cares about: dates, times, names, services, prices. E.g. "Tu cita: *mañana 16:00* con *Ana*."
- For 2+ items, write a bulleted list — one item per line, each starting with "• " — instead of cramming them into one comma-separated sentence.
- Separate distinct ideas with a line break instead of one long paragraph.
- Formatting improves readability; it does NOT license longer messages. Keep replies short. A single fact stays as one plain sentence — do not over-format trivial replies.`;

/** Deriva el `PersonaContext` desde el `Identity` del state. */
export function toPersonaContext(identity: Identity): PersonaContext {
  return {
    platformId: identity.platformId,
    profileType: identity.profileType,
    agentName: identity.agentName ?? null,
    countryCode: identity.countryCode ?? null,
    businessName: identity.tenantName ?? DEFAULT_BUSINESS_NAME,
    businessPolicies: identity.businessGeneralComments ?? null,
  };
}

/**
 * Escapa `<`/`>`/`&` para que un símbolo en las notas del negocio (texto libre
 * editable vía SQL) no rompa el XML del bloque del prompt. Mismo escapado que
 * usaba IDP_OV1 (`SystemPromptBuilder.escapeXml`).
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Bloque `<business_policies_and_notes>`: reglas y políticas operativas del
 * negocio como CONTEXTO AUTORITATIVO. Se emite para client y staff. `null`/
 * vacío/whitespace → '' (bloque omitido). El comentario instruye al LLM a usar
 * la política para alinear al usuario en lugar de marcar out-of-scope cuando una
 * política redefine el alcance (port literal de IDP_OV1).
 */
function buildBusinessPolicies(notes: string | null | undefined): string {
  if (notes == null) return '';
  const trimmed = notes.trim();
  if (trimmed.length === 0) return '';

  return `<business_policies_and_notes>
  <!-- Reglas operativas y politicas activas del negocio. Tratar este bloque
       como CONTEXTO AUTORITATIVO al responder. Si una politica aqui redefine el
       alcance (ej: medios de pago aceptados, condiciones de cancelacion,
       requisitos de confirmacion), usala en lugar de tratar el mensaje como
       fuera de scope. La respuesta debe alinear al usuario con la politica, no
       rechazar el tema. -->
  ${escapeXml(trimmed)}
</business_policies_and_notes>`;
}

function platformPersona(platformId: number, assistantName: string): string {
  switch (platformId) {
    case 1:
      return buildAlliaPrompt(assistantName);
    case 2:
      return buildGroomiaPrompt(assistantName);
    case 3:
      return buildDivappPrompt(assistantName);
    default:
      return buildAlliaPrompt(assistantName);
  }
}

/**
 * Construye el bloque de persona reutilizable. Las instrucciones van en inglés;
 * la salida al usuario va en español según la instrucción de acento.
 */
export function buildPersona(ctx: PersonaContext, opts?: BuildPersonaOptions): string {
  const assistantName = resolveAssistantName(ctx.platformId, ctx.profileType, ctx.agentName);

  const parts: string[] = [
    platformPersona(ctx.platformId, assistantName),
    `BUSINESS IDENTITY: You assist on behalf of "${ctx.businessName}". When greeting the user or naming the business, ALWAYS use "${ctx.businessName}" — NEVER the internal platform name (Allia/Divapp/Groomia).`,
    RESPONSE_FORMATTING,
  ];

  // Políticas/notas del negocio (autoritativo). Va después de la identidad del
  // negocio y antes del acento (que queda último). Omitido si no hay notas.
  const policies = buildBusinessPolicies(ctx.businessPolicies);
  if (policies.length > 0) parts.push(policies);

  if (opts?.aiIdentityDisclosure) {
    parts.push(
      `AI IDENTITY: You are ${assistantName}, the virtual assistant of "${ctx.businessName}". You are NOT a human, NOT the owner, NOT a staff member — never impersonate one. If the user addresses you by a person's first name or treats you as a specific human (e.g. asks how YOU personally are), open with ONE short warm clarification — "¡Hola! Soy ${assistantName}, el asistente virtual de ${ctx.businessName}." — and continue with their request in the same message. Never claim a personal human state ("estoy bien", "ahí ando") as if you were that person.`,
    );
  }

  parts.push(getAccentInstruction(ctx.countryCode));

  return parts.join('\n\n');
}
