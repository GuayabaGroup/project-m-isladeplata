import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'winston';

/**
 * Carga al startup el markdown comercial y de onboarding de cada plataforma
 * (Allia=1, Groomia=2, Divapp=3) y lo mantiene en memoria para inyección al
 * subgrafo `query` cuando un staff pregunta por el producto (Nivel B, H9.2).
 *
 * Port unificado de los dos loaders de IDP_OV1 (`PlatformCommercialContentLoader`
 * + `PlatformOnboardingContentLoader`), que eran idénticos salvo el subdirectorio.
 *
 *  - `commercial`: qué es la plataforma, precios/planes, features, contratación.
 *  - `onboarding`: cómo configurar el negocio, subir servicios/staff, conectar
 *    WhatsApp, horarios, compartir la URL de reservas, cómo agendan los clientes.
 *
 * Contrato:
 *   - `load(baseDir)` se llama UNA vez desde bootstrap antes de compilar el grafo.
 *   - El cache vive lo que vive el proceso. Cambios al markdown requieren
 *     reiniciar isladeplata (sin TTL ni hot-reload — paridad con IDP).
 *   - `get(kind, platformId)` retorna `undefined` si no hay contenido cargado
 *     (archivo ausente o vacío). En ese caso el subgrafo query escala a soporte
 *     determinísticamente para evitar que el LLM invente pasos/precios/URLs.
 */

export type PlatformContentKind = 'commercial' | 'onboarding';

/** Mapa platformId → nombre de archivo markdown (sin extensión de dir). */
const PLATFORM_FILES: ReadonlyArray<readonly [number, string]> = [
  [1, 'allia.md'],
  [2, 'groomia.md'],
  [3, 'divapp.md'],
];

const KINDS: readonly PlatformContentKind[] = ['commercial', 'onboarding'];

export class PlatformContentLoader {
  /** Clave `"${kind}:${platformId}"` → contenido markdown (trim). */
  private readonly cache = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  async load(baseDir: string): Promise<void> {
    for (const kind of KINDS) {
      for (const [platformId, filename] of PLATFORM_FILES) {
        const fullPath = path.join(baseDir, kind, filename);
        try {
          const raw = await fs.readFile(fullPath, 'utf-8');
          const content = raw.trim();
          if (content.length === 0) {
            this.logger.warn('Platform content markdown is empty, skipping', {
              kind,
              platformId,
              path: fullPath,
            });
            continue;
          }
          this.cache.set(this.key(kind, platformId), content);
        } catch (err) {
          this.logger.warn('Platform content markdown not loaded', {
            kind,
            platformId,
            path: fullPath,
            error: (err as Error).message,
          });
        }
      }
    }

    this.logger.info('PlatformContentLoader: loaded content', {
      count: this.cache.size,
      keys: Array.from(this.cache.keys()),
    });
  }

  get(kind: PlatformContentKind, platformId: number): string | undefined {
    return this.cache.get(this.key(kind, platformId));
  }

  private key(kind: PlatformContentKind, platformId: number): string {
    return `${kind}:${platformId}`;
  }
}
