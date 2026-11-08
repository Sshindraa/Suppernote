'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Gauge, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';

type Level = 'ok' | 'warning' | 'critical';

interface CapacityReport {
  limit: number;
  source: 'dashboard' | 'env' | 'default';
  setBy?: string;
  setAt?: string;
  activeNow: number;
  peakToday: number;
  peak7d: number;
  utilization: number;
  level: Level;
  thresholds: { warning: number; critical: number };
  history: Array<{ day: string; peak: number }>;
  measuredOnVps: boolean;
  generatedAt: string;
}

const SOURCE_LABELS: Record<CapacityReport['source'], string> = {
  dashboard: 'Réglé depuis cette page',
  env: 'Variable d’environnement',
  default: 'Valeur par défaut (estimation)',
};

const LEVEL_COPY: Record<Level, { label: string; hint: string }> = {
  ok: { label: 'Marge confortable', hint: 'Le pic reste sous la moitié du seuil.' },
  warning: {
    label: 'Anticiper',
    hint: 'Le pic dépasse la moitié du seuil : préparez la hausse de capacité.',
  },
  critical: {
    label: 'Relever maintenant',
    hint: 'Le pic dépasse 70 % du seuil : relevez la capacité avant de l’atteindre.',
  },
};

const percent = (ratio: number) => `${Math.round(ratio * 100)} %`;

export default function AdminCapacityPage() {
  const { get, put, del } = useApi();
  const [report, setReport] = useState<CapacityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await get<{ ok: boolean; capacity: CapacityReport }>('admin/voice-capacity');
      setReport(res.capacity);
      setDraft(String(res.capacity.limit));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Erreur lors du chargement de la capacité vocale'));
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async (action: () => Promise<{ ok: boolean; capacity: CapacityReport }>) => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await action();
      setReport(res.capacity);
      setDraft(String(res.capacity.limit));
      setSaved(true);
    } catch (err: unknown) {
      setSaveError(getErrorMessage(err, 'Impossible d’enregistrer le seuil'));
    } finally {
      setSaving(false);
    }
  };

  const draftNumber = Number(draft);
  const draftValid = Number.isInteger(draftNumber) && draftNumber >= 1 && draftNumber <= 500;
  const draftChanged = report ? draftNumber !== report.limit : false;
  const maxPeak = report ? Math.max(report.limit, ...report.history.map((h) => h.peak)) : 1;

  if (loading && !report) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="animate-spin" size={18} />
        Chargement de la capacité vocale…
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Gauge className="text-primary" size={22} />
          <div>
            <h1 className="text-xl font-semibold text-foreground">Capacité vocale</h1>
            <p className="text-sm text-muted-foreground">
              Appels simultanés : seuil actuel, usage, et réglage sans redéploiement.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="transition-all duration-200"
        >
          <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
          Actualiser
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle size={16} />
              <p className="text-sm">{error}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              className="transition-all duration-200"
            >
              Réessayer
            </Button>
          </CardContent>
        </Card>
      )}

      {report && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="transition-all duration-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Seuil actuel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="text-3xl font-semibold text-foreground">{report.limit}</p>
                <p className="text-xs text-muted-foreground">appels simultanés</p>
                <Badge variant="outline">{SOURCE_LABELS[report.source]}</Badge>
              </CardContent>
            </Card>
            <Card className="transition-all duration-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">En ce moment</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-foreground">{report.activeNow}</p>
                <p className="text-xs text-muted-foreground">appels en cours</p>
              </CardContent>
            </Card>
            <Card className="transition-all duration-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Pic aujourd’hui</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-foreground">{report.peakToday}</p>
                <p className="text-xs text-muted-foreground">appels simultanés</p>
              </CardContent>
            </Card>
            <Card
              className={cn(
                'transition-all duration-200',
                report.level === 'critical' && 'border-destructive/60',
                report.level === 'warning' && 'border-warning/60',
              )}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Pic sur 7 jours</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="text-3xl font-semibold text-foreground">
                  {report.peak7d}{' '}
                  <span className="text-base font-normal text-muted-foreground">
                    ({percent(report.utilization)} du seuil)
                  </span>
                </p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {report.level === 'ok' ? (
                    <CheckCircle2 size={12} className="text-success" />
                  ) : (
                    <TriangleAlert
                      size={12}
                      className={report.level === 'critical' ? 'text-destructive' : 'text-warning'}
                    />
                  )}
                  {LEVEL_COPY[report.level].label} : {LEVEL_COPY[report.level].hint}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Pic d’appels simultanés par jour
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="flex h-40 items-end gap-2"
                role="img"
                aria-label="Pic d’appels simultanés sur les 7 derniers jours"
              >
                {report.history.map((h) => (
                  <div key={h.day} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground">{h.peak}</span>
                    <div
                      className="w-full rounded-t bg-primary/70 transition-all duration-200"
                      style={{ height: `${Math.max(2, (h.peak / maxPeak) * 100)}%` }}
                    />
                    <span className="text-xs text-muted-foreground">
                      {h.day.slice(8)}/{h.day.slice(5, 7)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Seuil : {report.limit}. Alerte à {percent(report.thresholds.warning)} (anticiper)
                puis {percent(report.thresholds.critical)} (relever maintenant) du seuil, selon le
                pic sur 7 jours.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Régler le seuil</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {report.measuredOnVps
                  ? 'Seuil mesuré sur le serveur.'
                  : 'Ce seuil est une estimation : il n’a pas été mesuré sur le serveur de production. Mesurez la capacité réelle hors heures de service avant de le relever.'}{' '}
                Au seuil, un appel entrant reçoit un message d’occupation puis est raccroché : c’est
                un dernier filet, le suivi ci-dessus sert à relever la capacité avant.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="capacity-limit">Appels simultanés (1 à 500)</Label>
                  <Input
                    id="capacity-limit"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={500}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setSaved(false);
                    }}
                    className="w-40"
                  />
                </div>
                <Button
                  onClick={() => apply(() => put('admin/voice-capacity', { limit: draftNumber }))}
                  disabled={saving || !draftValid || !draftChanged}
                  className="transition-all duration-200"
                >
                  {saving && <Loader2 className="animate-spin" size={14} />}
                  Enregistrer
                </Button>
                {report.source === 'dashboard' && (
                  <Button
                    variant="outline"
                    onClick={() => apply(() => del('admin/voice-capacity'))}
                    disabled={saving}
                    className="transition-all duration-200"
                  >
                    Revenir à la valeur du serveur
                  </Button>
                )}
              </div>
              {!draftValid && draft !== '' && (
                <p className="text-sm text-destructive">Entrez un entier entre 1 et 500.</p>
              )}
              {saveError && <p className="text-sm text-destructive">{saveError}</p>}
              {saved && (
                <p className="flex items-center gap-1.5 text-sm text-success">
                  <CheckCircle2 size={14} />
                  Seuil enregistré. Il s’applique sous 15 secondes, sans redéploiement.
                </p>
              )}
              {report.source === 'dashboard' && report.setBy && (
                <p className="text-xs text-muted-foreground">
                  Dernière modification par {report.setBy}
                  {report.setAt ? ` le ${new Date(report.setAt).toLocaleString('fr-FR')}` : ''}.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
