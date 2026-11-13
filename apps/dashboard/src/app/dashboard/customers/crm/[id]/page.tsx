'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Check,
  CircleDot,
  Clock,
  Copy,
  Download,
  Gift,
  Loader2,
  Lock,
  Mail,
  MoreHorizontal,
  Plus,
  Phone,
  RefreshCw,
  Save,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { MarketingConsentCard } from '@/components/crm/marketing-consent-card';
import { CustomerRealSpendCard, type CustomerRealSpend } from '@/components/pos/real-spend';
import { useApi } from '@/lib/api';
import { ApiError, featureLockFromError, type FeatureLock } from '@/lib/api-error';
import { getErrorMessage, type CustomerVisitSummary } from '@/types/api';
import { FeatureLockCard } from '@/components/FeatureLockCard';
import { formatPhone } from '@/lib/utils';
import { toast } from 'sonner';

type CustomerIdentity = {
  id: string;
  type: string;
  value: string;
  normalizedValue: string;
  source?: string;
  verifiedAt?: string | null;
};

type CustomerPreference = {
  id: string;
  key: string;
  value: unknown;
  source: string;
  confidence: number | string | null;
  confirmedAt?: string | null;
  expiresAt?: string | null;
  updatedAt: string;
};

type CustomerTag = { id: string; key: string; label: string; colorToken?: string | null };
type CustomerTagAssignment = { tag: CustomerTag; source: string; assignedAt: string };

type CustomerMetricSnapshot = {
  honored30d: number;
  honored90d: number;
  honored365d: number;
  cancelled365d: number;
  noShow365d: number;
  covers365d: number;
  estimatedSpend365d: number | string;
  actualSpend365d: number | string | null;
  actualLifetimeSpend: number | string | null;
  lastHonoredAt: string | null;
  nextReservationAt: string | null;
  calculatedAt: string;
};

type TimelineEvent = {
  id: string;
  summaryCode: string;
  eventType: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
};

type CrmCustomerDetail = {
  id: string;
  name: string | null;
  phone: string;
  emailNormalized: string | null;
  isVip: boolean;
  notes: string | null;
  visitSummary?: CustomerVisitSummary | null;
  // Absent sans ticket de caisse rapproché ou sans droit pos.connect.
  realSpend?: CustomerRealSpend | null;
  identities: CustomerIdentity[];
  // « basic » (Essential) : ni valeur ni tags ; l'API omet ces champs.
  crmAccess?: 'basic' | 'pro';
  metricSnapshot?: CustomerMetricSnapshot | null;
  metrics?: CustomerMetricSnapshot | null;
  preferences: CustomerPreference[];
  tags: CustomerTag[];
  tagAssignments: CustomerTagAssignment[];
  timeline: TimelineEvent[];
};

type ExportVerificationResponse = {
  channel: 'sms' | 'email';
  expiresAt: string;
  rateLimitRemaining: number;
  captchaRequired: boolean;
};

type ExportConfirmationResponse = { verificationToken: string };

type ExportPayload = {
  exportedAt?: string;
  privacyPolicyVersion?: string;
  reservations?: unknown[];
  crmProfiles?: unknown[];
  crmMergeAudits?: unknown[];
  marketingPermissions?: unknown[];
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDay(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('fr-FR') : '—';
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}

/** Libellés des préférences structurées ; les clés techniques ne sont jamais montrées. */
const PREFERENCE_LABELS: Record<string, string> = {
  preferred_section: 'Zone préférée',
  preferred_table: 'Table préférée',
  dietary_restrictions: 'Régimes alimentaires',
  accessibility_needs: 'Accessibilité',
  preferred_language: 'Langue préférée',
  occasion_type: 'Occasion habituelle',
  service_preference: 'Service préféré',
  group_pattern: 'Taille de groupe habituelle',
};
const LIST_PREFERENCES = new Set(['dietary_restrictions', 'accessibility_needs']);

/** Entendue par l'agent pendant un appel et pas encore confirmée : il ne s'en sert pas. */
function isPendingVoiceSuggestion(preference: CustomerPreference): boolean {
  return preference.source === 'VOICE_SUGGESTION' && !preference.confirmedAt;
}

/** Une suggestion vocale expirée sans confirmation ne s'affiche plus. */
function isVisiblePreference(preference: CustomerPreference, now = Date.now()): boolean {
  if (!isPendingVoiceSuggestion(preference) || !preference.expiresAt) return true;
  return new Date(preference.expiresAt).getTime() > now;
}

function preferenceLabel(key: string): string {
  return PREFERENCE_LABELS[key] ?? 'Autre préférence';
}

/** Texte saisi → valeur envoyée à l'API : liste séparée par des virgules, ou texte simple. */
function preferenceValueFromInput(key: string, text: string): string | string[] {
  const trimmed = text.trim();
  if (!LIST_PREFERENCES.has(key)) return trimmed;
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function preferenceInputFromValue(value: unknown): string {
  return value === null || value === undefined ? '' : displayValue(value);
}

/** Clé technique d'un tag, déduite de son nom : « VIP régulier » → « vip_regulier ». */
function tagKeyFromLabel(label: string): string {
  const slug = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 60);
  return slug.length >= 2 ? slug : `tag_${slug || 'client'}`;
}

/** Événements de la chronologie, en français. Un code inconnu ne s'affiche jamais. */
const TIMELINE_LABELS: Record<string, string> = {
  'reservation.created': 'Réservation créée',
  'reservation.cancelled': 'Réservation annulée',
  'reservation.honored': 'Visite honorée',
  'reservation.no_show': 'Client absent (no-show)',
  'call.received': 'Appel reçu',
  'waitlist.joined': "Inscrit sur la liste d'attente",
  'waitlist.promoted': "Place obtenue depuis la liste d'attente",
  'waitlist.cancelled': "Retiré de la liste d'attente",
  'waitlist.expired': "Liste d'attente expirée",
  'gift_card.purchased': 'Carte cadeau achetée',
  'gift_card.redeemed': 'Carte cadeau utilisée',
  'customer.tag_assigned': 'Tag ajouté',
  'customer.tag_removed': 'Tag retiré',
  'customer.preference_updated': 'Préférence enregistrée',
  'customer.preference_removed': 'Préférence supprimée',
  'customer.preference_suggested': 'Préférence entendue au téléphone',
  'customer.merged': 'Profils fusionnés',
  'customer.metrics_repaired': 'Chiffres du client recalculés',
  'marketing.permission_updated': 'Consentement marketing mis à jour',
};

function timelineLabel(code: string): string {
  return TIMELINE_LABELS[code] ?? 'Événement';
}

const TIMELINE_ICONS: Record<string, LucideIcon> = {
  reservation: CalendarDays,
  call: Phone,
  waitlist: Clock,
  gift_card: Gift,
  customer: UserRound,
  marketing: Mail,
};

function timelineIcon(code: string): LucideIcon {
  return TIMELINE_ICONS[code.split('.')[0]] ?? CircleDot;
}

function initials(name: string | null): string {
  return (
    (name || '?')
      .split(' ')
      .filter(Boolean)
      .map((word) => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-[9rem] flex-1 bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

type ProfileTab = 'activity' | 'preferences' | 'consents';

const IDENTITY_LABELS: Record<string, string> = {
  PHONE: 'Téléphone',
  EMAIL: 'E-mail',
  POS: 'Caisse',
};

export default function CrmCustomerPage() {
  const params = useParams<{ id: string }>();
  const customerId = params?.id;
  const { get, post, put, del, orgId } = useApi();
  const [customer, setCustomer] = useState<CrmCustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // La fiche n'existe plus (fusion, effacement) : inutile de proposer « Réessayer ».
  const [notFound, setNotFound] = useState(false);
  // Fiche ouverte depuis l'écran Clients sans CRM Pro : on montre l'offre, pas une erreur.
  const [lock, setLock] = useState<FeatureLock | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCode, setExportCode] = useState('');
  const [exportStep, setExportStep] = useState<'idle' | 'requesting' | 'confirming' | 'done'>(
    'idle',
  );
  const [exportError, setExportError] = useState('');
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportRequest, setExportRequest] = useState<ExportVerificationResponse | null>(null);
  const [exportPayload, setExportPayload] = useState<ExportPayload | null>(null);
  const [tab, setTab] = useState<ProfileTab>('activity');
  const [preferenceFormOpen, setPreferenceFormOpen] = useState(false);
  const [preferenceKey, setPreferenceKey] = useState('preferred_language');
  const [preferenceValue, setPreferenceValue] = useState('');
  const [editingPreferenceId, setEditingPreferenceId] = useState<string | null>(null);
  const [tagLabel, setTagLabel] = useState('');
  const [crmMutationLoading, setCrmMutationLoading] = useState(false);
  const [crmMutationError, setCrmMutationError] = useState('');

  const load = useCallback(async () => {
    if (!orgId || !customerId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setNotFound(false);
    setLock(null);
    try {
      const response = await get<{ data: CrmCustomerDetail }>(`crm/customers/${customerId}`);
      // La fiche simple (Essential) arrive sans tags : listes vides pour garder un seul rendu.
      setCustomer(
        response.data
          ? {
              ...response.data,
              tags: response.data.tags ?? [],
              tagAssignments: response.data.tagAssignments ?? [],
            }
          : null,
      );
    } catch (err: unknown) {
      setNotFound(err instanceof ApiError && err.kind === 'not-found');
      setLock(featureLockFromError(err));
      setError(getErrorMessage(err, 'Impossible de charger la fiche CRM.'));
      setCustomer(null);
    } finally {
      setLoading(false);
    }
  }, [customerId, get, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  function downloadExport(payload: ExportPayload): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `suppernote-crm-export-${customerId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function requestExportCode(): Promise<void> {
    if (!customer?.phone) return;
    setExportStep('requesting');
    setExportError('');
    setExportPayload(null);
    try {
      const response = await post<ExportVerificationResponse>('api/rgpd/request-verification', {
        subject: customer.phone,
        intent: 'export',
      });
      setExportRequest(response);
      setExportCode('');
      setExportStep('confirming');
    } catch (err: unknown) {
      setExportError(getErrorMessage(err, "Impossible d'envoyer le code d'export"));
      setExportStep('idle');
    }
  }

  async function confirmExport(): Promise<void> {
    if (!customer?.phone || !exportCode.trim() || exportSubmitting) return;
    setExportSubmitting(true);
    setExportError('');
    let confirmation: ExportConfirmationResponse;
    try {
      confirmation = await post<ExportConfirmationResponse>('api/rgpd/confirm-verification', {
        subject: customer.phone,
        intent: 'export',
        code: exportCode.trim(),
      });
    } catch (err: unknown) {
      // Code refusé : il reste saisissable, le restaurateur peut corriger ou demander un nouveau code.
      setExportError(getErrorMessage(err, 'Le code n’a pas pu être vérifié.'));
      setExportSubmitting(false);
      return;
    }
    try {
      const payload = await post<ExportPayload>(
        'api/rgpd/export',
        { subject: customer.phone },
        { headers: { 'X-Identity-Token': confirmation.verificationToken } },
      );
      setExportPayload(payload);
      setExportStep('done');
      downloadExport(payload);
    } catch (err: unknown) {
      // Le code est à usage unique et vient d'être consommé : il faut en demander un nouveau.
      setExportError(getErrorMessage(err, 'L’export n’a pas pu être généré.'));
      setExportStep('idle');
    } finally {
      setExportSubmitting(false);
    }
  }

  function editPreference(preference: CustomerPreference): void {
    setPreferenceFormOpen(true);
    setEditingPreferenceId(preference.id);
    setPreferenceKey(preference.key);
    setPreferenceValue(preferenceInputFromValue(preference.value));
    setCrmMutationError('');
  }

  function resetPreferenceForm(): void {
    setPreferenceFormOpen(false);
    setEditingPreferenceId(null);
    setPreferenceKey('preferred_language');
    setPreferenceValue('');
  }

  async function savePreference(): Promise<void> {
    if (!customerId) return;
    const value = preferenceValueFromInput(preferenceKey, preferenceValue);
    if (Array.isArray(value) ? value.length === 0 : !value) {
      setCrmMutationError('Indiquez une valeur pour cette préférence.');
      return;
    }
    setCrmMutationLoading(true);
    setCrmMutationError('');
    try {
      const response = await put<{ data: CustomerPreference }>(
        `crm/customers/${customerId}/preferences/${preferenceKey}`,
        {
          value,
          source: 'MANUAL',
          confidence: 1,
          confirmedAt: new Date().toISOString(),
        },
      );
      const saved = response.data;
      setCustomer((current) => {
        if (!current) return current;
        const preferences = [
          ...current.preferences.filter((item) => item.key !== saved.key),
          saved,
        ].sort((left, right) => left.key.localeCompare(right.key));
        return { ...current, preferences };
      });
      toast.success('Préférence enregistrée.');
      resetPreferenceForm();
    } catch (err: unknown) {
      setCrmMutationError(getErrorMessage(err, 'Impossible d’enregistrer la préférence.'));
    } finally {
      setCrmMutationLoading(false);
    }
  }

  async function confirmPreference(preference: CustomerPreference): Promise<void> {
    if (!customerId) return;
    setCrmMutationLoading(true);
    setCrmMutationError('');
    try {
      const response = await put<{ data: CustomerPreference }>(
        `crm/customers/${customerId}/preferences/${preference.key}`,
        {
          value: preference.value,
          source: preference.source,
          confidence: 1,
          confirmedAt: new Date().toISOString(),
          expiresAt: null,
        },
      );
      const saved = response.data;
      setCustomer((current) =>
        current
          ? {
              ...current,
              preferences: current.preferences.map((item) =>
                item.key === saved.key ? saved : item,
              ),
            }
          : current,
      );
      toast.success('Préférence confirmée.');
    } catch (err: unknown) {
      setCrmMutationError(getErrorMessage(err, 'Impossible de confirmer la préférence.'));
    } finally {
      setCrmMutationLoading(false);
    }
  }

  async function removePreference(preference: CustomerPreference): Promise<void> {
    if (!customerId) return;
    setCrmMutationLoading(true);
    setCrmMutationError('');
    try {
      await del(`crm/customers/${customerId}/preferences/${preference.key}`);
      setCustomer((current) =>
        current
          ? {
              ...current,
              preferences: current.preferences.filter((item) => item.id !== preference.id),
            }
          : current,
      );
      if (editingPreferenceId === preference.id) resetPreferenceForm();
      toast.success('Préférence supprimée.');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.kind === 'not-found') {
        // Déjà supprimée ailleurs : on recharge la fiche plutôt que d'afficher une erreur.
        await load();
        return;
      }
      setCrmMutationError(getErrorMessage(err, 'Impossible de supprimer la préférence.'));
    } finally {
      setCrmMutationLoading(false);
    }
  }

  async function saveTag(): Promise<void> {
    if (!customerId || !tagLabel.trim()) return;
    setCrmMutationLoading(true);
    setCrmMutationError('');
    try {
      const response = await post<{
        data: { tag: CustomerTag; assignment: CustomerTagAssignment };
      }>(`crm/customers/${customerId}/tags`, {
        key: tagKeyFromLabel(tagLabel),
        label: tagLabel.trim(),
        source: 'MANUAL',
      });
      const { tag, assignment } = response.data;
      setCustomer((current) => {
        if (!current) return current;
        const tags = current.tags.some((item) => item.id === tag.id)
          ? current.tags.map((item) => (item.id === tag.id ? tag : item))
          : [...current.tags, tag];
        const tagAssignments = [
          ...current.tagAssignments.filter((item) => item.tag.id !== tag.id),
          assignment,
        ];
        return { ...current, tags, tagAssignments };
      });
      setTagLabel('');
      toast.success('Tag ajouté.');
    } catch (err: unknown) {
      setCrmMutationError(getErrorMessage(err, 'Impossible d’ajouter le tag.'));
    } finally {
      setCrmMutationLoading(false);
    }
  }

  async function removeTag(tag: CustomerTag): Promise<void> {
    if (!customerId) return;
    setCrmMutationLoading(true);
    setCrmMutationError('');
    try {
      await del(`crm/customers/${customerId}/tags/${tag.id}`);
      setCustomer((current) =>
        current
          ? {
              ...current,
              tags: current.tags.filter((item) => item.id !== tag.id),
              tagAssignments: current.tagAssignments.filter((item) => item.tag.id !== tag.id),
            }
          : current,
      );
      toast.success('Tag retiré.');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.kind === 'not-found') {
        await load();
        return;
      }
      setCrmMutationError(getErrorMessage(err, 'Impossible de retirer le tag.'));
    } finally {
      setCrmMutationLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    );
  }

  if (lock) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="transition-all duration-200">
          <Link href="/dashboard/customers">
            <ArrowLeft size={16} />
            Retour aux clients
          </Link>
        </Button>
        <FeatureLockCard lock={lock} feature="CRM Pro" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/customers">
            <ArrowLeft size={16} />
            Retour aux clients
          </Link>
        </Button>
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-destructive">
            <AlertCircle className="mt-0.5 shrink-0" size={18} />
            <div className="space-y-3">
              <p role="alert">{error || 'Client introuvable.'}</p>
              {notFound ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="transition-all duration-200"
                  onClick={() => void load()}
                >
                  <RefreshCw size={14} />
                  Réessayer
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const metrics = customer.metrics ?? customer.metricSnapshot;
  const isPro = customer.crmAccess !== 'basic';
  const visiblePreferences = customer.preferences.filter((preference) =>
    isVisiblePreference(preference),
  );
  const pendingSuggestions = visiblePreferences.filter(isPendingVoiceSuggestion).length;
  const spend = metrics?.actualLifetimeSpend;
  const tabs: { id: ProfileTab; label: string; badge?: number }[] = [
    { id: 'activity', label: 'Activité' },
    { id: 'preferences', label: 'Préférences', badge: pendingSuggestions || undefined },
    ...(isPro ? [{ id: 'consents' as const, label: 'Consentements' }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/dashboard/customers">
            <ArrowLeft size={16} />
            Retour aux clients
          </Link>
        </Button>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span
              aria-hidden="true"
              className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-secondary text-base font-semibold text-foreground"
            >
              {initials(customer.name)}
            </span>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">
                  {customer.name || 'Client sans nom'}
                </h1>
                {customer.isVip ? (
                  <Badge variant="outline" className="gap-1">
                    <Star size={12} className="fill-current" />
                    VIP
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <a
                  href={`tel:${customer.phone}`}
                  className="inline-flex items-center gap-1.5 tabular-nums transition-all duration-200 hover:text-foreground"
                >
                  <Phone size={14} />
                  {formatPhone(customer.phone)}
                </a>
                {customer.emailNormalized ? (
                  <a
                    href={`mailto:${customer.emailNormalized}`}
                    className="inline-flex items-center gap-1.5 transition-all duration-200 hover:text-foreground"
                  >
                    <Mail size={14} />
                    {customer.emailNormalized}
                  </a>
                ) : null}
                {customer.identities.map((identity) => (
                  <span key={identity.id}>
                    {IDENTITY_LABELS[identity.type] ?? 'Autre coordonnée'} · {identity.value}
                  </span>
                ))}
              </div>
              {isPro ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {customer.tags.map((tag) => (
                    <Badge key={tag.id} variant="secondary" className="gap-1 pr-1">
                      {tag.label}
                      <button
                        type="button"
                        aria-label={`Retirer le tag ${tag.label}`}
                        onClick={() => void removeTag(tag)}
                        disabled={crmMutationLoading}
                        className="rounded-sm p-0.5 text-muted-foreground transition-all duration-200 hover:bg-background hover:text-foreground"
                      >
                        <X size={12} />
                      </button>
                    </Badge>
                  ))}
                  <form
                    className="inline-flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveTag();
                    }}
                  >
                    <Input
                      value={tagLabel}
                      onChange={(event) => setTagLabel(event.target.value)}
                      placeholder="Nouveau tag"
                      aria-label="Nom du tag"
                      maxLength={80}
                      disabled={crmMutationLoading}
                      className="h-7 w-32 text-xs"
                    />
                    {tagLabel.trim() ? (
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={crmMutationLoading}
                      >
                        <Plus size={12} />
                        Ajouter
                      </Button>
                    ) : null}
                  </form>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-none gap-2">
            {isPro ? (
              <Button asChild variant="outline" size="sm" className="transition-all duration-200">
                <Link href="/dashboard/customers/crm/duplicates">
                  <Copy size={14} />
                  Doublons
                </Link>
              </Button>
            ) : null}
            {/* Export RGPD est rare : on le range dans un menu. Menu non modal : il ouvre un dialogue,
                et deux couches modales se disputent le focus. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="transition-all duration-200"
                  aria-label="Plus d’actions"
                >
                  <MoreHorizontal size={16} />
                </Button>
              </DropdownMenuTrigger>
              {/* Le dialogue doit garder le focus : le menu ne le rend pas au bouton à la fermeture. */}
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenuItem
                  onSelect={() => {
                    setExportOpen(true);
                    setExportError('');
                  }}
                >
                  <ShieldCheck size={14} />
                  Export RGPD
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <dl className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Stat
          label="Visites · 365 j"
          value={customer.visitSummary?.visits365d ?? metrics?.honored365d ?? 0}
        />
        {isPro ? (
          <Stat label="Couverts · 365 j" value={formatNumber(metrics?.covers365d ?? 0)} />
        ) : null}
        <Stat
          label="No-show · 365 j"
          value={customer.visitSummary?.noShows365d ?? metrics?.noShow365d ?? 0}
        />
        {isPro ? (
          <Stat
            label="Dépense encaissée"
            value={spend === null || spend === undefined ? '—' : `${formatNumber(spend)} €`}
          />
        ) : null}
        <Stat
          label="Dernière visite"
          value={formatDay(customer.visitSummary?.lastVisitAt ?? metrics?.lastHonoredAt)}
        />
      </dl>

      <CustomerRealSpendCard spend={customer.realSpend} />

      {isPro ? null : (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Lock size={12} aria-hidden="true" />
          Valeur client, tags, doublons et consentements : CRM Pro.
          <Link
            href="/pricing"
            className="underline underline-offset-4 transition-all duration-200 hover:text-foreground"
          >
            Voir les formules
          </Link>
        </p>
      )}

      {crmMutationError ? <p className="text-xs text-destructive">{crmMutationError}</p> : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ProfileTab)}>
        <TabsList aria-label="Fiche client">
          {tabs.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
              {item.badge ? (
                <span className="rounded-full bg-warning/15 px-1.5 text-xs tabular-nums text-foreground">
                  {item.badge}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="activity">
          {customer.timeline.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Aucune activité.</p>
          ) : (
            <ol className="rounded-lg border border-border bg-card px-4">
              {customer.timeline.map((event) => {
                const Icon = timelineIcon(event.summaryCode);
                return (
                  <li
                    key={event.id}
                    className="flex items-center gap-3 border-b border-border py-3 last:border-0"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <Icon size={14} />
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {timelineLabel(event.summaryCode)}
                    </p>
                    <p className="flex-none text-xs tabular-nums text-muted-foreground">
                      {formatDate(event.occurredAt)}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </TabsContent>

        <TabsContent value="preferences">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPreferenceFormOpen(true);
                  setEditingPreferenceId(null);
                  setCrmMutationError('');
                }}
                disabled={crmMutationLoading}
              >
                <Plus size={14} />
                Ajouter
              </Button>
            </div>
            {visiblePreferences.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Aucune préférence.</p>
            ) : (
              <dl className="divide-y divide-border text-sm">
                {visiblePreferences.map((preference) =>
                  isPendingVoiceSuggestion(preference) ? (
                    <div
                      key={preference.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                    >
                      <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                        <dt className="text-muted-foreground">{preferenceLabel(preference.key)}</dt>
                        <dd className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
                          <span className="truncate">{displayValue(preference.value)}</span>
                          <Badge variant="outline" className="gap-1 font-normal">
                            <Phone size={12} />
                            Entendu au téléphone, à confirmer
                          </Badge>
                        </dd>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="transition-all duration-200"
                          onClick={() => void confirmPreference(preference)}
                          disabled={crmMutationLoading}
                        >
                          <Check size={14} />
                          Confirmer
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="transition-all duration-200"
                          aria-label={`Écarter la suggestion ${preferenceLabel(preference.key)}`}
                          onClick={() => void removePreference(preference)}
                          disabled={crmMutationLoading}
                        >
                          <X size={14} />
                          Écarter
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={preference.id}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                        <dt className="text-muted-foreground">{preferenceLabel(preference.key)}</dt>
                        <dd className="truncate font-medium">{displayValue(preference.value)}</dd>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => editPreference(preference)}
                          disabled={crmMutationLoading}
                        >
                          Modifier
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Supprimer la préférence ${preferenceLabel(preference.key)}`}
                          onClick={() => void removePreference(preference)}
                          disabled={crmMutationLoading}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ),
                )}
              </dl>
            )}
            {preferenceFormOpen ? (
              <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">
                    {editingPreferenceId ? 'Modifier la préférence' : 'Nouvelle préférence'}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Fermer le formulaire de préférence"
                    onClick={resetPreferenceForm}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    value={preferenceKey}
                    onChange={(event) => setPreferenceKey(event.target.value)}
                    aria-label="Type de préférence"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    disabled={crmMutationLoading || Boolean(editingPreferenceId)}
                  >
                    {Object.entries(PREFERENCE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={preferenceValue}
                    onChange={(event) => setPreferenceValue(event.target.value)}
                    placeholder={
                      LIST_PREFERENCES.has(preferenceKey) ? 'sans gluten, végétarien' : 'terrasse'
                    }
                    aria-label="Valeur de la préférence"
                    disabled={crmMutationLoading}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void savePreference()}
                    disabled={crmMutationLoading || !preferenceValue.trim()}
                  >
                    <Save size={14} />
                    Enregistrer
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={resetPreferenceForm}>
                    Annuler
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </TabsContent>

        {isPro ? (
          <TabsContent value="consents">
            <MarketingConsentCard customerId={customer.id} email={customer.emailNormalized} />
          </TabsContent>
        ) : null}
      </Tabs>

      <Dialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open);
          setExportError('');
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export RGPD</DialogTitle>
            <DialogDescription>
              Réservations, profil et consentements de ce client, après vérification par code.
            </DialogDescription>
          </DialogHeader>

          {exportStep === 'idle' ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Un code à usage unique sera envoyé au {formatPhone(customer.phone)}.
              </p>
              <Button type="button" onClick={() => void requestExportCode()}>
                Envoyer le code SMS
              </Button>
            </div>
          ) : null}

          {exportStep === 'requesting' ? (
            <p className="text-sm text-muted-foreground">Envoi du code…</p>
          ) : null}

          {exportStep === 'confirming' && exportRequest ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Code envoyé par {exportRequest.channel === 'sms' ? 'SMS' : 'e-mail'}.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={exportCode}
                  onChange={(event) =>
                    setExportCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  aria-label="Code d’export RGPD"
                  className="tabular-nums sm:max-w-32"
                  disabled={exportSubmitting}
                />
                <Button
                  type="button"
                  className="transition-all duration-200"
                  onClick={() => void confirmExport()}
                  disabled={exportCode.length !== 6 || exportSubmitting}
                >
                  {exportSubmitting ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      Vérification…
                    </>
                  ) : (
                    'Télécharger l’export'
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="transition-all duration-200"
                  disabled={exportSubmitting}
                  onClick={() => void requestExportCode()}
                >
                  Renvoyer
                </Button>
              </div>
            </div>
          ) : null}

          {exportStep === 'done' && exportPayload ? (
            <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-success">Export téléchargé.</p>
                <p className="text-muted-foreground">
                  Généré le {formatDate(exportPayload.exportedAt)}.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={() => downloadExport(exportPayload)}>
                <Download size={15} />
                Télécharger à nouveau
              </Button>
            </div>
          ) : null}

          {exportError ? <p className="text-sm text-destructive">{exportError}</p> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
