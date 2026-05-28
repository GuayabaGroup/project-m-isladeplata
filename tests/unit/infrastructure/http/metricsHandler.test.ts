import express from 'express';
import { Counter, Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createMetricsHandler } from '../../../../src/infrastructure/http/metricsHandler.js';

function makeApp(apiKey: string): {
  app: express.Express;
  registry: Registry;
  counter: Counter<string>;
} {
  const registry = new Registry();
  const counter = new Counter({
    name: 'test_counter',
    help: 'unit test counter',
    registers: [registry],
  });
  const app = express();
  app.get('/metrics', createMetricsHandler(registry, apiKey));
  return { app, registry, counter };
}

async function request(
  app: express.Express,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const headerEntries = Object.entries(headers);
      void (async () => {
        const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
          headers: headerEntries.reduce<Record<string, string>>((acc, [k, v]) => {
            acc[k] = v;
            return acc;
          }, {}),
        });
        const body = await res.text();
        server.close();
        resolve({
          status: res.status,
          body,
          contentType: res.headers.get('content-type') ?? undefined,
        });
      })();
    });
  });
}

describe('GET /metrics endpoint', () => {
  it('200 with valid X-Metrics-Key + counter exposition', async () => {
    const { app, counter } = makeApp('secret-key-123');
    counter.inc();
    const res = await request(app, { 'X-Metrics-Key': 'secret-key-123' });
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/plain/);
    expect(res.body).toContain('test_counter 1');
  });

  it('401 when X-Metrics-Key header is missing', async () => {
    const { app } = makeApp('secret-key-123');
    const res = await request(app);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Unauthorized');
  });

  it('401 when X-Metrics-Key header does not match', async () => {
    const { app } = makeApp('secret-key-123');
    const res = await request(app, { 'X-Metrics-Key': 'wrong-key' });
    expect(res.status).toBe(401);
  });

  it('404 when apiKey is empty (defensive — bootstrap should not mount)', async () => {
    const { app } = makeApp('');
    const res = await request(app, { 'X-Metrics-Key': 'anything' });
    expect(res.status).toBe(404);
  });
});
