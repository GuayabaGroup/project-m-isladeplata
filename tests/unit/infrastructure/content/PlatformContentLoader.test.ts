import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { PlatformContentLoader } from '../../../../src/infrastructure/content/PlatformContentLoader.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

let baseDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-content-'));
  await fs.mkdir(path.join(baseDir, 'commercial'), { recursive: true });
  await fs.mkdir(path.join(baseDir, 'onboarding'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function write(rel: string, content: string): Promise<void> {
  await fs.writeFile(path.join(baseDir, rel), content, 'utf-8');
}

describe('PlatformContentLoader', () => {
  it('carga archivos presentes y los expone por (kind, platformId)', async () => {
    await write('commercial/allia.md', '# Allia\nPlan Pro.');
    await write('onboarding/groomia.md', '# Groomia\nPrimeros pasos.');

    const loader = new PlatformContentLoader(mockLogger);
    await loader.load(baseDir);

    expect(loader.get('commercial', 1)).toBe('# Allia\nPlan Pro.');
    expect(loader.get('onboarding', 2)).toBe('# Groomia\nPrimeros pasos.');
  });

  it('archivo ausente → get retorna undefined', async () => {
    const loader = new PlatformContentLoader(mockLogger);
    await loader.load(baseDir);
    expect(loader.get('commercial', 3)).toBeUndefined();
    expect(loader.get('onboarding', 1)).toBeUndefined();
  });

  it('archivo vacío / solo whitespace → no se cachea (escalación activa)', async () => {
    await write('commercial/allia.md', '');
    await write('commercial/groomia.md', '   \n  \t ');

    const loader = new PlatformContentLoader(mockLogger);
    await loader.load(baseDir);

    expect(loader.get('commercial', 1)).toBeUndefined();
    expect(loader.get('commercial', 2)).toBeUndefined();
  });

  it('trimea el contenido cargado', async () => {
    await write('commercial/divapp.md', '\n\n  # Divapp  \n\n');
    const loader = new PlatformContentLoader(mockLogger);
    await loader.load(baseDir);
    expect(loader.get('commercial', 3)).toBe('# Divapp');
  });

  it('directorio base inexistente → no lanza, todo undefined', async () => {
    const loader = new PlatformContentLoader(mockLogger);
    await loader.load(path.join(baseDir, 'no-existe'));
    expect(loader.get('commercial', 1)).toBeUndefined();
    expect(loader.get('onboarding', 1)).toBeUndefined();
  });
});
