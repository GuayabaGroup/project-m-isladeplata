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
 * asistente resuelto) → regla de identidad del negocio → (opcional) disclosure
 * de IA → instrucción de acento. El acento va ÚLTIMO para que sus pronombres
 * (voseo/tuteo) prevalezcan sobre cualquier ejemplo de la persona.
 */

export interface PersonaContext {
  platformId: number;
  profileType: ProfileType;
  agentName: string | null;
  countryCode: string | null;
  businessName: string;
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

/** Deriva el `PersonaContext` desde el `Identity` del state. */
export function toPersonaContext(identity: Identity): PersonaContext {
  return {
    platformId: identity.platformId,
    profileType: identity.profileType,
    agentName: identity.agentName ?? null,
    countryCode: identity.countryCode ?? null,
    businessName: identity.tenantName ?? DEFAULT_BUSINESS_NAME,
  };
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
  ];

  if (opts?.aiIdentityDisclosure) {
    parts.push(
      `AI IDENTITY: You are ${assistantName}, the virtual assistant of "${ctx.businessName}". You are NOT a human, NOT the owner, NOT a staff member — never impersonate one. If the user addresses you by a person's first name or treats you as a specific human (e.g. asks how YOU personally are), open with ONE short warm clarification — "¡Hola! Soy ${assistantName}, el asistente virtual de ${ctx.businessName}." — and continue with their request in the same message. Never claim a personal human state ("estoy bien", "ahí ando") as if you were that person.`,
    );
  }

  parts.push(getAccentInstruction(ctx.countryCode));

  return parts.join('\n\n');
}
