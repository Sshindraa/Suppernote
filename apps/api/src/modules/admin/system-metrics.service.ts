/**
 * Courbes de supervision pour la page admin « Capacité et système » : lecture de Prometheus (déjà installé sur
 * le serveur, 30 jours d'historique). Aucune requête libre : seuls des panneaux prédéfinis sont interrogés, et
 * seulement pour la production.
 */

export const RANGES = {
  '6h': { seconds: 6 * 3_600, step: 60 },
  '24h': { seconds: 24 * 3_600, step: 300 },
  '7d': { seconds: 7 * 24 * 3_600, step: 1_800 },
} as const;

export type MetricsRange = keyof typeof RANGES;

export interface PanelSeriesDefinition {
  name: string;
  query: string;
}

export interface PanelDefinition {
  id: string;
  title: string;
  unit: string;
  series: PanelSeriesDefinition[];
}

const API = 'job="sokar-api"';
const WORKERS = 'job="sokar-workers"';

export const PANELS: PanelDefinition[] = [
  {
    id: 'calls',
    title: 'Appels simultanés et seuil',
    unit: 'appels',
    series: [
      { name: 'Appels en cours', query: `max(sokar_voice_active_sessions{${API}})` },
      { name: 'Seuil', query: `max(sokar_voice_capacity_limit{${API}})` },
    ],
  },
  {
    id: 'redis',
    title: 'Mémoire de Redis face à son plafond',
    unit: '%',
    series: [{ name: 'Redis', query: `max(sokar_redis_memory_ratio{${WORKERS}}) * 100` }],
  },
  {
    id: 'api-memory',
    title: 'Mémoire du processus API',
    unit: 'Mo',
    series: [{ name: 'API', query: `max(process_resident_memory_bytes{${API}}) / 1048576` }],
  },
  {
    id: 'api-cpu',
    title: 'CPU du processus API',
    unit: '% d’un cœur',
    series: [{ name: 'API', query: `max(rate(process_cpu_seconds_total{${API}}[5m])) * 100` }],
  },
  {
    id: 'queues',
    title: 'Files de tâches',
    unit: 'jobs',
    series: [
      { name: 'En échec', query: `sum(sokar_queue_jobs{${WORKERS},state="failed"})` },
      { name: 'En attente', query: `sum(sokar_queue_jobs{${WORKERS},state="waiting"})` },
    ],
  },
  {
    id: 'webhooks',
    title: 'Webhooks Telnyx sur 15 minutes',
    unit: 'webhooks',
    series: [
      {
        name: 'En erreur ou rejetés',
        query: `sum(increase(sokar_telnyx_webhook_events_total{${API},result=~"error|rejected"}[15m]))`,
      },
      {
        name: 'Total',
        query: `sum(increase(sokar_telnyx_webhook_events_total{${API}}[15m]))`,
      },
    ],
  },
];

export interface SeriesResult {
  name: string;
  points: Array<{ t: number; v: number }>;
}

export interface PanelResult {
  id: string;
  title: string;
  unit: string;
  series: SeriesResult[];
  error?: string;
}

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const TIMEOUT_MS = 5_000;

export function prometheusUrl(): string {
  return (process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090').replace(/\/$/, '');
}

async function querySeries(
  definition: PanelSeriesDefinition,
  range: MetricsRange,
  now: number,
  fetcher: Fetcher,
): Promise<SeriesResult> {
  const { seconds, step } = RANGES[range];
  const params = new URLSearchParams({
    query: definition.query,
    start: String(Math.floor(now / 1000) - seconds),
    end: String(Math.floor(now / 1000)),
    step: String(step),
  });
  const response = await fetcher(`${prometheusUrl()}/api/v1/query_range?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Prometheus a répondu ${response.status}`);
  const body = (await response.json()) as {
    status?: string;
    data?: { result?: Array<{ values?: Array<[number, string]> }> };
  };
  if (body.status !== 'success') throw new Error('Réponse Prometheus invalide');
  const values = body.data?.result?.[0]?.values ?? [];
  return {
    name: definition.name,
    points: values
      .map(([t, v]) => ({ t: t * 1000, v: Number(v) }))
      .filter((p) => Number.isFinite(p.v)),
  };
}

export async function getSystemMetrics(
  range: MetricsRange,
  options: { now?: number; fetcher?: Fetcher } = {},
): Promise<PanelResult[]> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? (fetch as unknown as Fetcher);
  return Promise.all(
    PANELS.map(async (panel): Promise<PanelResult> => {
      const settled = await Promise.allSettled(
        panel.series.map((definition) => querySeries(definition, range, now, fetcher)),
      );
      const series = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
      const failed = settled.find((s) => s.status === 'rejected');
      return {
        id: panel.id,
        title: panel.title,
        unit: panel.unit,
        series,
        ...(failed && series.length === 0
          ? { error: 'Prometheus est injoignable ou n’a pas répondu' }
          : {}),
      };
    }),
  );
}
