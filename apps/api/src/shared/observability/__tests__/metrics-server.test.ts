import { afterAll, describe, expect, it } from 'vitest';
import { startMetricsServer, type MetricsServerHandle } from '../metrics-server';

let handle: MetricsServerHandle | null = null;

afterAll(async () => {
  await handle?.close();
});

describe('startMetricsServer', () => {
  it('expose /metrics en texte Prometheus sur la loopback', async () => {
    handle = await startMetricsServer({ port: 0, host: '127.0.0.1' });
    expect(handle.port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const body = await response.text();
    // Les métriques publiées par le process worker doivent être visibles.
    expect(body).toContain('suppernote_slo_status');
    expect(body).toContain('suppernote_queue_jobs');
  });

  it('ne sert que /metrics', async () => {
    const response = await fetch(`http://127.0.0.1:${handle?.port}/health`);
    expect(response.status).toBe(404);
  });

  it('refuse une méthode non GET', async () => {
    const response = await fetch(`http://127.0.0.1:${handle?.port}/metrics`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
