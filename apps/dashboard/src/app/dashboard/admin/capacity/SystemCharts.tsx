'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';

type Range = '6h' | '24h' | '7d';

export interface PanelData {
  id: string;
  title: string;
  unit: string;
  series: Array<{ name: string; points: Array<{ t: number; v: number }> }>;
  error?: string;
}

const RANGES: Array<{ id: Range; label: string }> = [
  { id: '6h', label: '6 heures' },
  { id: '24h', label: '24 heures' },
  { id: '7d', label: '7 jours' },
];

// Couleurs du thème : jamais de valeur codée en dur.
const SERIES_COLORS = ['hsl(var(--primary))', 'hsl(var(--muted-foreground))'];
const GRID_COLOR = 'hsl(var(--border))';
const AXIS_COLOR = 'hsl(var(--muted-foreground))';

/** Fusionne les séries d'un panneau en lignes {t, <nom>: valeur} pour recharts. */
export function mergeSeries(panel: PanelData): Array<Record<string, number>> {
  const byTime = new Map<number, Record<string, number>>();
  panel.series.forEach((series, index) => {
    for (const point of series.points) {
      const row = byTime.get(point.t) ?? { t: point.t };
      row[`s${index}`] = Number(point.v.toFixed(2));
      byTime.set(point.t, row);
    }
  });
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function formatTime(t: number, range: Range): string {
  const date = new Date(t);
  return range === '7d'
    ? date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
    : date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function PanelCard({ panel, range }: { panel: PanelData; range: Range }) {
  const rows = mergeSeries(panel);
  const hasData = rows.length > 0;
  return (
    <Card className="transition-all duration-200">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
          <span>{panel.title}</span>
          <span className="text-xs font-normal text-muted-foreground">{panel.unit}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {panel.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle size={14} />
            {panel.error}
          </p>
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">
            Pas encore de mesure sur cette période : cette courbe se remplit au fil du temps.
          </p>
        ) : (
          <>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
                <LineChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 6" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickFormatter={(t: number) => formatTime(t, range)}
                    stroke={AXIS_COLOR}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    stroke={AXIS_COLOR}
                    tick={{ fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    labelFormatter={(t) => new Date(Number(t)).toLocaleString('fr-FR')}
                    isAnimationActive={false}
                  />
                  {panel.series.map((series, index) => (
                    <Line
                      key={series.name}
                      type="monotone"
                      dataKey={`s${index}`}
                      name={series.name}
                      stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                      strokeDasharray={index === 0 ? undefined : '4 4'}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {panel.series.map((series, index) => (
                <span key={series.name} className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn('w-4 border-t-2', index > 0 && 'border-dashed')}
                    style={{ borderColor: SERIES_COLORS[index % SERIES_COLORS.length] }}
                  />
                  {series.name}
                </span>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Courbes de supervision lues dans Prometheus (production), réservées aux opérateurs. */
export function SystemCharts() {
  const { get } = useApi();
  const [range, setRange] = useState<Range>('24h');
  const [panels, setPanels] = useState<PanelData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (selected: Range) => {
      setLoading(true);
      setError(null);
      try {
        const res = await get<{ ok: boolean; panels: PanelData[] }>(
          `admin/system-metrics?range=${selected}`,
        );
        setPanels(res.panels);
      } catch (err: unknown) {
        setError(getErrorMessage(err, 'Erreur lors du chargement des courbes'));
      } finally {
        setLoading(false);
      }
    },
    [get],
  );

  useEffect(() => {
    load(range);
  }, [load, range]);

  return (
    <section aria-label="Courbes du système" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Le système dans le temps</h2>
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Période"
            className="inline-flex rounded-md border border-border"
          >
            {RANGES.map((r) => (
              <Button
                key={r.id}
                variant={range === r.id ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
                className="transition-all duration-200"
              >
                {r.label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(range)}
            disabled={loading}
            aria-label="Actualiser les courbes"
            className="transition-all duration-200"
          >
            <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle size={16} />
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(range)}
              className="transition-all duration-200"
            >
              Réessayer
            </Button>
          </CardContent>
        </Card>
      )}

      {loading && !panels && (
        <div className="flex items-center gap-2 p-6 text-muted-foreground">
          <Loader2 className="animate-spin" size={18} />
          Chargement des courbes…
        </div>
      )}

      {panels && (
        <div className="grid gap-4 xl:grid-cols-2">
          {panels.map((panel) => (
            <PanelCard key={panel.id} panel={panel} range={range} />
          ))}
        </div>
      )}
    </section>
  );
}
