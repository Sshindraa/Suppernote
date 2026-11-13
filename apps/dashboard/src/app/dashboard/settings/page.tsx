'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { normalizePhone } from '@suppernote/shared';
import { useApi } from '../../../lib/api';
import {
  getErrorMessage,
  type Restaurant,
  type AgentPersonality,
  type CapacitySpecials,
  type BillingStatus,
} from '@/types/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { OnboardingLockBanner } from '@/features/onboarding/onboarding-guard';
import { DataFetchError } from '@/components/DataFetchError';
import { isValidPhoneInput } from '@/features/onboarding/phone-format';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import {
  Save,
  Bot,
  Store,
  AlertCircle,
  CheckCircle2,
  ArrowUpRight,
  Gift,
  Languages,
  ListOrdered,
  ShieldCheck,
} from 'lucide-react';
import { SYSTEM_PROMPT_EXTRA_MAX_LENGTH } from '@/constants/ui';
import { SiteManagementCard } from '@/features/sites/site-management-card';
import { TeamCard } from '@/features/team/team-card';
import { CardGuaranteeSettingsCard } from '@/features/card-guarantee/card-guarantee-settings-card';
import { useSiteSelection } from '@/features/sites/site-context';
import { TrialRecap, TrialTrack } from '@/features/billing/trial';

// Aucun quota d'appels n'existe dans l'offre : les formules ne se distinguent pas par un plafond
// (une ancienne mention « 1 500 appels / mois » n'était implémentée nulle part).
const PLAN_FEATURES: Record<string, { label: string; calls: string }> = {
  STARTER: { label: 'Essential', calls: 'Appels inclus' },
  PRO: { label: 'Pro', calls: 'Appels inclus, copilote de service' },
  PREMIUM: { label: 'Multi-restaurant', calls: 'Appels inclus, plusieurs adresses' },
};

const PROFILE_OPTIONS = [
  { value: 'BISTROT_BRASSERIE', label: 'Bistrot / Brasserie' },
  { value: 'GASTRONOMIQUE', label: 'Gastronomique' },
  { value: 'SEMI_GASTRO', label: 'Semi-gastronomique' },
];

const FILLER_OPTIONS = [
  { value: 'CASUAL', label: 'Décontracté', desc: 'Je regarde ça…' },
  { value: 'WARM', label: 'Chaleureux', desc: 'Pas de souci, je regarde ça !' },
  { value: 'FORMAL', label: 'Formel', desc: 'Veuillez patienter un instant…' },
];

const CRM_PRIVACY_ROLES = [
  { value: 'OWNER', label: 'Propriétaires', description: 'Accès complet aux notes sensibles.' },
  { value: 'MANAGER', label: 'Managers', description: 'Accès opérationnel aux notes du site.' },
  { value: 'STAFF', label: 'Équipe de service', description: 'Accès pendant le service.' },
  {
    value: 'READ_ONLY',
    label: 'Lecture seule',
    description: 'Accès en lecture sans modification.',
  },
  {
    value: 'ORG_MEMBER',
    label: 'Membres de l’organisation',
    description: 'Accès organisationnel générique.',
  },
] as const;

type CrmPrivacyResponse = {
  data?: {
    sensitiveNoteRoles?: string[];
    source?: 'SITE' | 'ENVIRONMENT';
  };
};

export default function SettingsPage() {
  const { get, post, patch, orgId } = useApi();
  const { accountId, activeSite } = useSiteSelection();
  const tLanguage = useTranslations('languageSwitcher');

  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [name, setName] = useState('');
  const [managerPhone, setManagerPhone] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [openingBillingPortal, setOpeningBillingPortal] = useState(false);
  // Après le paiement, Stripe confirme quelques secondes plus tard : on relit le statut jusqu'à ce qu'il change.
  const [awaitingBilling, setAwaitingBilling] = useState(false);

  // Personality
  const [personality, setPersonality] = useState<AgentPersonality | null>(null);
  const [profileType, setProfileType] = useState('BISTROT_BRASSERIE');
  const [fillerStyle, setFillerStyle] = useState('CASUAL');
  const [speakingRate, setSpeakingRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [voiceIdCa, setVoiceIdCa] = useState('');
  const [pronunciationDictId, setPronunciationDictId] = useState('');
  const [emotion, setEmotion] = useState('');
  const [systemPromptExtra, setSystemPromptExtra] = useState('');
  const [savingPersonality, setSavingPersonality] = useState(false);
  const [savedPersonality, setSavedPersonality] = useState(false);

  // File d'attente
  const [capacitySpecials, setCapacitySpecials] = useState<CapacitySpecials>({});
  const [waitingListEnabled, setWaitingListEnabled] = useState(false);
  const [waitingListMaxEntriesPerSlot, setWaitingListMaxEntriesPerSlot] = useState<number>(10);
  const [savingWaitingList, setSavingWaitingList] = useState(false);
  const [savedWaitingList, setSavedWaitingList] = useState(false);

  // Cartes cadeaux
  const [giftCardEnabled, setGiftCardEnabled] = useState(false);
  const [savingGiftCard, setSavingGiftCard] = useState(false);
  const [savedGiftCard, setSavedGiftCard] = useState(false);

  // CRM privacy
  const [crmPrivacyRoles, setCrmPrivacyRoles] = useState<string[]>(['OWNER', 'MANAGER']);
  const [crmPrivacySource, setCrmPrivacySource] = useState<'SITE' | 'ENVIRONMENT'>('ENVIRONMENT');
  const [loadingCrmPrivacy, setLoadingCrmPrivacy] = useState(false);
  // Tant que la disponibilité du réglage n'est pas connue, ni la carte ni son lien ne s'affichent.
  const [crmPrivacyChecked, setCrmPrivacyChecked] = useState(false);
  // Le réglage n'existe que si le CRM avancé est ouvert pour ce compte : sinon l'API le refuse et la carte
  // ne doit pas s'afficher (elle montrerait une case « enregistrée » qui ne l'est jamais).
  const [crmPrivacyUnavailable, setCrmPrivacyUnavailable] = useState(false);
  const [savingCrmPrivacy, setSavingCrmPrivacy] = useState(false);
  const [savedCrmPrivacy, setSavedCrmPrivacy] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('billing') === 'success') {
        setBillingNotice(
          'Souscription confirmée. Votre formule s’affichera ici dans quelques instants.',
        );
        setAwaitingBilling(true);
        window.history.replaceState({}, '', window.location.pathname);
      } else if (params.get('billing') === 'portal-return') {
        setBillingNotice('Vous êtes revenu du portail de gestion de votre abonnement.');
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  }, []);

  useEffect(() => {
    if (!awaitingBilling || !orgId) return;
    let attempts = 0;
    let stopped = false;
    const poll = window.setInterval(() => {
      attempts += 1;
      void get<BillingStatus>('billing/status')
        .then((status) => {
          if (stopped) return;
          setBillingStatus(status);
          if (
            status?.subscriptionStatus === 'active' ||
            status?.subscriptionStatus === 'trialing'
          ) {
            // La formule vient d'être mise à jour : on recharge aussi le restaurant pour afficher la bonne.
            void get<Restaurant>(`restaurants/${orgId}`)
              .then((data) => {
                if (!stopped) setRestaurant(data);
              })
              .catch(() => undefined);
            setBillingNotice('Souscription confirmée : votre formule est à jour.');
            setAwaitingBilling(false);
          }
        })
        .catch(() => undefined);
      if (attempts >= 10) {
        setBillingNotice(
          'Votre formule n’est pas encore à jour. Rechargez la page dans une minute.',
        );
        setAwaitingBilling(false);
      }
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(poll);
    };
  }, [awaitingBilling, get, orgId]);

  const loadSettings = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadError('');
    {
      try {
        const [data, pers, billing] = await Promise.all([
          get<Restaurant>(`restaurants/${orgId}`),
          get<AgentPersonality>(`restaurants/${orgId}/personality`),
          get<BillingStatus>('billing/status').catch(() => null),
        ]);
        setRestaurant(data);
        setBillingStatus(billing);
        setName(data.name || '');
        setManagerPhone(data.managerPhone || '');
        setManagerEmail(data.managerEmail || '');
        if (pers && pers.id) {
          setPersonality(pers);
          setProfileType(pers.profileType || 'BISTROT_BRASSERIE');
          setFillerStyle(pers.fillerStyle || 'CASUAL');
          setSpeakingRate(Number(pers.speakingRate) || 1.0);
          setVolume(Number(pers.volume) || 1.0);
          setVoiceIdCa(pers.voiceIdCa || '');
          setPronunciationDictId(pers.pronunciationDictId || '');
          setEmotion(pers.emotion || '');
          setSystemPromptExtra(pers.systemPromptExtra || '');
        }
        const specials = (data.exposureSettings?.capacitySpecials ?? {}) as CapacitySpecials;
        setCapacitySpecials(specials);
        setWaitingListEnabled(specials.waitingListEnabled === true);
        setWaitingListMaxEntriesPerSlot(
          typeof specials.waitingListMaxEntriesPerSlot === 'number'
            ? specials.waitingListMaxEntriesPerSlot
            : 10,
        );
        setGiftCardEnabled(data.giftCardEnabled === true);
      } catch (err: unknown) {
        setLoadError(getErrorMessage(err, 'Impossible de charger vos paramètres.'));
      } finally {
        setLoading(false);
      }
    }
  }, [orgId, get]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Une erreur d'enregistrement s'affiche en haut d'une page très longue : on l'amène sous les yeux.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [error]);

  useEffect(() => {
    const canManage = !accountId || activeSite?.role === 'OWNER';
    if (!orgId || !canManage) return;
    let cancelled = false;
    setLoadingCrmPrivacy(true);
    setCrmPrivacyChecked(false);
    setCrmPrivacyUnavailable(false);
    void get<CrmPrivacyResponse>('crm/privacy')
      .then((response) => {
        if (cancelled) return;
        const roles = response.data?.sensitiveNoteRoles;
        setCrmPrivacyRoles(
          Array.isArray(roles) && roles.includes('OWNER') ? roles : ['OWNER', 'MANAGER'],
        );
        setCrmPrivacySource(response.data?.source === 'SITE' ? 'SITE' : 'ENVIRONMENT');
      })
      .catch(() => {
        // Politique indisponible pour ce compte (CRM avancé fermé, ou hors formule) : pas de carte.
        if (!cancelled) setCrmPrivacyUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingCrmPrivacy(false);
          setCrmPrivacyChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, activeSite?.role, get, orgId]);

  if (loading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-8 w-40" />
        <Card className="sokar-card">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Sans paramètres chargés, aucun formulaire : il afficherait une formule, une file d'attente et une
  // personnalité par défaut, et « Enregistrer » écraserait les vrais réglages avec ces valeurs.
  if (!restaurant) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Paramètres</h1>
        <DataFetchError
          message={`${loadError || 'Impossible de charger vos paramètres.'} Vos réglages n’ont pas été modifiés.`}
          onRetry={() => void loadSettings()}
          retrying={loading}
        />
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');

    if (managerPhone.trim() && !isValidPhoneInput(managerPhone)) {
      setError('Numéro de téléphone invalide. Exemple : 06 12 34 56 78 ou +33 6 12 34 56 78.');
      setSaving(false);
      return;
    }

    try {
      // L'API attend un numéro international : « 06 12 34 56 78 » devient « +33612345678 ».
      const payload: Record<string, unknown> = {
        name,
        managerPhone: managerPhone.trim() ? normalizePhone(managerPhone) : managerPhone,
        managerEmail,
      };
      await patch(`restaurants/${orgId}`, payload);
      setSaved(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Erreur lors de la sauvegarde'));
    } finally {
      setSaving(false);
    }
  }

  async function handlePersonalitySave(e: React.FormEvent) {
    e.preventDefault();
    setSavingPersonality(true);
    setSavedPersonality(false);
    setError('');

    try {
      await patch(`restaurants/${orgId}/personality`, {
        profileType,
        fillerStyle,
        speakingRate,
        volume,
        voiceIdCa: voiceIdCa || undefined,
        pronunciationDictId: pronunciationDictId || undefined,
        emotion: emotion || undefined,
        systemPromptExtra: systemPromptExtra || undefined,
      });
      setSavedPersonality(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Erreur lors de la sauvegarde de la personnalité'));
    } finally {
      setSavingPersonality(false);
    }
  }

  async function handleWaitingListSave(e: React.FormEvent) {
    e.preventDefault();
    setSavingWaitingList(true);
    setSavedWaitingList(false);
    setError('');

    try {
      const nextSpecials: CapacitySpecials = { ...capacitySpecials, waitingListEnabled };
      if (waitingListEnabled) {
        nextSpecials.waitingListMaxEntriesPerSlot = waitingListMaxEntriesPerSlot;
      }
      await patch(`restaurants/${orgId}`, { capacitySpecials: nextSpecials });
      setSavedWaitingList(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Erreur lors de la sauvegarde de la file d'attente"));
    } finally {
      setSavingWaitingList(false);
    }
  }

  async function handleGiftCardToggle(enabled: boolean) {
    setGiftCardEnabled(enabled);
    setSavingGiftCard(true);
    setSavedGiftCard(false);
    setError('');

    try {
      await patch(`restaurants/${orgId}`, { giftCardEnabled: enabled });
      setSavedGiftCard(true);
      if (restaurant) {
        setRestaurant({ ...restaurant, giftCardEnabled: enabled });
      }
    } catch (err: unknown) {
      setGiftCardEnabled(!enabled);
      setError(getErrorMessage(err, 'Erreur lors de la sauvegarde des cartes cadeaux'));
    } finally {
      setSavingGiftCard(false);
    }
  }

  function toggleCrmPrivacyRole(role: string) {
    if (role === 'OWNER') return;
    setSavedCrmPrivacy(false);
    setCrmPrivacyRoles((current) =>
      current.includes(role) ? current.filter((value) => value !== role) : [...current, role],
    );
  }

  async function handleCrmPrivacySave() {
    setSavingCrmPrivacy(true);
    setSavedCrmPrivacy(false);
    setError('');
    try {
      const response = await patch<CrmPrivacyResponse>('crm/privacy', {
        sensitiveNoteRoles: crmPrivacyRoles,
      });
      const roles = response.data?.sensitiveNoteRoles;
      if (Array.isArray(roles) && roles.includes('OWNER')) setCrmPrivacyRoles(roles);
      setCrmPrivacySource('SITE');
      setSavedCrmPrivacy(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Erreur lors de la sauvegarde de la visibilité CRM'));
    } finally {
      setSavingCrmPrivacy(false);
    }
  }

  async function handleOpenBillingPortal() {
    setOpeningBillingPortal(true);
    setError('');
    try {
      const session = await post<{ url?: string }>('billing/portal-session');
      if (!session.url) throw new Error('Le portail de gestion est indisponible.');
      window.location.assign(session.url);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible d'ouvrir la gestion de l'abonnement"));
    } finally {
      setOpeningBillingPortal(false);
    }
  }

  const plan = restaurant?.plan ?? 'STARTER';
  const planInfo = PLAN_FEATURES[plan] ?? PLAN_FEATURES.STARTER;
  const canManageBilling = !accountId || activeSite?.role === 'OWNER';
  const canManageCrmPrivacy =
    (!accountId || activeSite?.role === 'OWNER') && crmPrivacyChecked && !crmPrivacyUnavailable;
  const billingStatusLabel =
    billingStatus?.subscriptionStatus === 'past_due'
      ? 'Paiement en attente'
      : billingStatus?.subscriptionStatus === 'active'
        ? 'Abonnement actif'
        : billingStatus?.subscriptionStatus === 'trialing'
          ? 'Période d’essai'
          : billingStatus?.subscriptionStatus === 'canceled'
            ? 'Abonnement terminé'
            : 'Aucun abonnement synchronisé';
  const billingPeriodEnd = billingStatus?.currentPeriodEnd
    ? new Date(billingStatus.currentPeriodEnd).toLocaleDateString('fr-FR', {
        dateStyle: 'long',
      })
    : null;
  const billingIntervalLabel =
    billingStatus?.billingInterval === 'annual' ? 'Facturation annuelle' : 'Facturation mensuelle';

  // Chaque lien suit la carte qu'il annonce : pas de lien vers une carte absente.
  const sectionLinks: Array<[string, string, boolean]> = [
    ['settings-info', 'Restaurant', true],
    ['settings-crm', 'CRM', canManageCrmPrivacy],
    ['settings-display', 'Affichage', true],
    ['settings-plan', 'Abonnement', true],
    ['settings-waiting-list', 'File d’attente', true],
    ['settings-gift-cards', 'Cartes cadeaux', true],
    ['settings-agent', 'Assistant', true],
  ];

  return (
    <div className="space-y-8">
      <OnboardingLockBanner task="restaurant" />
      <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Paramètres</h1>

      <nav
        aria-label="Sections des paramètres"
        className="sticky top-2 z-10 -mx-1 overflow-x-auto px-1 pb-1 md:max-w-fit"
      >
        <div className="flex min-w-max items-center gap-1.5 rounded-xl border border-border bg-background/90 p-1.5 shadow-sm backdrop-blur">
          {sectionLinks
            .filter(([, , visible]) => visible)
            .map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="inline-flex h-8 items-center rounded-lg border border-transparent px-2.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </a>
            ))}
        </div>
      </nav>

      {error && (
        <div ref={errorRef} role="alert" className="sokar-error">
          <AlertCircle size={18} />
          {error}
        </div>
      )}

      {billingNotice && (
        <div className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm text-foreground">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
          <span>{billingNotice}</span>
        </div>
      )}

      {/* Infos restaurant */}
      <Card id="settings-info" className="sokar-card scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Store size={18} />
            Informations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="max-w-full sm:max-w-lg space-y-4">
            <div className="space-y-2">
              <label htmlFor="restaurant-name" className="text-sm font-medium">
                Nom du restaurant
              </label>
              <Input
                id="restaurant-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="manager-phone" className="text-sm font-medium">
                Téléphone du gérant
              </label>
              <Input
                id="manager-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="06 12 34 56 78"
                value={managerPhone}
                onChange={(e) => {
                  setManagerPhone(e.target.value);
                  setSaved(false);
                }}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="manager-email" className="text-sm font-medium">
                Email du gérant
              </label>
              <Input
                id="manager-email"
                type="email"
                autoComplete="email"
                value={managerEmail}
                onChange={(e) => {
                  setManagerEmail(e.target.value);
                  setSaved(false);
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saving}>
                <Save size={16} className="mr-1" />
                {saving ? 'Enregistrement...' : 'Enregistrer'}
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-sm text-primary">
                  <CheckCircle2 size={16} />
                  Enregistré
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <SiteManagementCard />
      <TeamCard />
      <CardGuaranteeSettingsCard restaurantName={restaurant?.name || name || 'Votre restaurant'} />

      {canManageCrmPrivacy && (
        <Card id="settings-crm" className="sokar-card scroll-mt-24 transition-all duration-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck size={18} />
              Visibilité des notes CRM
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Choisissez les rôles de cet établissement qui peuvent lire les notes client et les
              métadonnées de chronologie. Le rôle propriétaire reste toujours autorisé.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {loadingCrmPrivacy ? (
              <Skeleton className="h-24 w-full rounded-xl" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CRM_PRIVACY_ROLES.map((role) => (
                    <label
                      key={role.value}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-secondary p-4 transition-all duration-200 hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={crmPrivacyRoles.includes(role.value)}
                        disabled={role.value === 'OWNER' || savingCrmPrivacy}
                        onChange={() => toggleCrmPrivacyRole(role.value)}
                        className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {role.label}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {role.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={() => void handleCrmPrivacySave()}
                    disabled={savingCrmPrivacy}
                  >
                    <Save size={16} />
                    {savingCrmPrivacy ? 'Enregistrement...' : 'Enregistrer la visibilité'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Source :{' '}
                    {crmPrivacySource === 'SITE' ? 'règle de ce site' : 'règle environnement'}
                  </span>
                  {savedCrmPrivacy && (
                    <span className="flex items-center gap-1 text-sm text-primary">
                      <CheckCircle2 size={16} />
                      Enregistré
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Préférences d'affichage */}
      <Card id="settings-display" className="sokar-card scroll-mt-24 transition-all duration-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Languages size={18} />
            {tLanguage('settingsTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-secondary p-5 transition-all duration-200 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">{tLanguage('label')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tLanguage('settingsDescription')}
              </p>
            </div>
            <LanguageSwitcher />
          </div>
        </CardContent>
      </Card>

      {/* Plan actuel */}
      <Card id="settings-plan" className="sokar-card scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-lg">Plan actuel</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-secondary p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xl font-bold capitalize">{planInfo.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {planInfo.calls} · Pas de commission · Support email
              </p>
              {billingStatus && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={
                      billingStatus.subscriptionStatus === 'past_due'
                        ? 'rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 font-medium text-warning'
                        : billingStatus.subscriptionStatus === 'active' ||
                            billingStatus.subscriptionStatus === 'trialing'
                          ? 'rounded-full border border-success/30 bg-success/10 px-2.5 py-1 font-medium text-success'
                          : 'rounded-full border border-border bg-background px-2.5 py-1 font-medium text-muted-foreground'
                    }
                  >
                    {billingStatusLabel}
                  </span>
                  {billingStatus.subscriptionStatus && billingStatus.billingInterval && (
                    <span className="text-muted-foreground">{billingIntervalLabel}</span>
                  )}
                </div>
              )}
              {billingStatus?.subscriptionStatus === 'trialing' && billingStatus.trial && (
                <div className="mt-5 max-w-xl space-y-4">
                  <TrialTrack trial={billingStatus.trial} />
                  <TrialRecap trial={billingStatus.trial} />
                  <p className="text-sm text-muted-foreground">
                    {canManageBilling
                      ? `Ajoutez une carte avant le ${billingPeriodEnd} pour que Suppernote continue de répondre. Aucun prélèvement avant cette date.`
                      : `Le propriétaire du compte doit ajouter une carte avant le ${billingPeriodEnd}.`}
                  </p>
                </div>
              )}
              {billingStatus?.suspended && (
                <p role="alert" className="mt-3 max-w-xl text-sm text-destructive">
                  Votre abonnement est terminé : Suppernote ne répond plus aux appels.{' '}
                  {canManageBilling
                    ? 'Choisissez une formule pour le réactiver.'
                    : 'Le propriétaire du compte doit choisir une formule pour le réactiver.'}{' '}
                  Si votre ligne est encore renvoyée vers Suppernote, désactivez ce renvoi chez
                  votre opérateur pour que vos clients vous joignent directement.
                </p>
              )}
              {billingStatus?.subscriptionStatus === 'past_due' && (
                <p role="alert" className="mt-3 max-w-xl text-sm text-warning">
                  Le dernier paiement n’a pas abouti.{' '}
                  {canManageBilling
                    ? 'Ouvrez la gestion de l’abonnement pour mettre à jour votre moyen de paiement.'
                    : 'Le propriétaire du compte doit mettre à jour le moyen de paiement.'}
                </p>
              )}
              {billingStatus?.cancelAtPeriodEnd && billingPeriodEnd && (
                <p className="mt-3 max-w-xl text-sm text-muted-foreground">
                  Résiliation programmée le {billingPeriodEnd}. L’accès reste actif jusqu’à cette
                  date.
                </p>
              )}
              {billingStatus?.subscriptionStatus &&
                billingStatus.subscriptionStatus !== 'canceled' &&
                billingStatus.subscriptionStatus !== 'trialing' &&
                !billingStatus.cancelAtPeriodEnd &&
                billingPeriodEnd && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Prochaine échéance : {billingPeriodEnd}
                  </p>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href="/dashboard/billing">
                  Mon abonnement
                  <ArrowUpRight size={14} className="ml-1" />
                </a>
              </Button>
              {canManageBilling && (
                <Button
                  variant={billingStatus?.subscriptionStatus === 'trialing' ? 'default' : 'outline'}
                  onClick={handleOpenBillingPortal}
                  disabled={openingBillingPortal}
                  className={
                    billingStatus?.subscriptionStatus === 'trialing'
                      ? 'rounded-full px-5'
                      : undefined
                  }
                >
                  {openingBillingPortal
                    ? 'Ouverture...'
                    : billingStatus?.subscriptionStatus === 'trialing'
                      ? 'Ajouter une carte'
                      : 'Gérer l’abonnement'}
                </Button>
              )}
              <Button variant="outline" asChild>
                <a href="/pricing">
                  Changer de plan
                  <ArrowUpRight size={14} className="ml-1" />
                </a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* File d&apos;attente */}
      <Card
        id="settings-waiting-list"
        className="sokar-card scroll-mt-24 transition-all duration-200"
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListOrdered size={18} />
            File d&apos;attente
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleWaitingListSave} className="max-w-full sm:max-w-lg space-y-5">
            <div className="flex flex-col gap-4 rounded-2xl border border-border bg-secondary p-5 transition-all duration-200 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-foreground">Activer la file d&apos;attente</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Proposer automatiquement une table aux clients en attente quand une place se
                  libère.
                </p>
              </div>
              <Switch
                id="waiting-list-enabled"
                checked={waitingListEnabled}
                onCheckedChange={(value) => {
                  setWaitingListEnabled(value);
                  setSavedWaitingList(false);
                }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="waiting-list-max">
                Nombre max d&apos;inscrits par créneau
              </label>
              <Input
                id="waiting-list-max"
                type="number"
                min={1}
                max={50}
                value={waitingListMaxEntriesPerSlot}
                disabled={!waitingListEnabled}
                onChange={(e) => {
                  setWaitingListMaxEntriesPerSlot(Number(e.target.value));
                  setSavedWaitingList(false);
                }}
                className="transition-all duration-200"
              />
              <p className="text-xs text-muted-foreground">Entre 1 et 50 inscrits.</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={savingWaitingList}>
                <Save size={16} className="mr-1" />
                {savingWaitingList ? 'Enregistrement...' : 'Enregistrer'}
              </Button>
              {savedWaitingList && (
                <span className="flex items-center gap-1 text-sm text-primary">
                  <CheckCircle2 size={16} />
                  Enregistré
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Cartes cadeaux */}
      <Card
        id="settings-gift-cards"
        className="sokar-card scroll-mt-24 transition-all duration-200"
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Gift size={18} />
            Cartes cadeaux
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 rounded-2xl border border-border bg-secondary p-5 transition-all duration-200 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">Activer les cartes cadeaux</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Permettez à vos clients d&apos;acheter des cartes cadeaux depuis votre widget de
                réservation.
              </p>
              {savedGiftCard && (
                <span className="mt-2 flex items-center gap-1 text-xs font-medium text-primary animate-fade-in">
                  <CheckCircle2 size={14} />
                  Enregistré
                </span>
              )}
            </div>
            <Switch
              id="gift-card-enabled"
              checked={giftCardEnabled}
              disabled={savingGiftCard}
              onCheckedChange={handleGiftCardToggle}
            />
          </div>
        </CardContent>
      </Card>

      {/* Personnalité de l'agent vocal */}
      <Card id="settings-agent" className="sokar-card scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot size={18} />
            Personnalité de l&apos;assistant
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePersonalitySave} className="max-w-full sm:max-w-lg space-y-5">
            <div className="space-y-2">
              <label className="text-sm font-medium">Type de restaurant</label>
              <select
                value={profileType}
                onChange={(e) => {
                  setProfileType(e.target.value);
                  setSavedPersonality(false);
                }}
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {PROFILE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Style de l&apos;assistant</label>
              <select
                value={fillerStyle}
                onChange={(e) => {
                  setFillerStyle(e.target.value);
                  setSavedPersonality(false);
                }}
                className="flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {FILLER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} — {opt.desc}
                  </option>
                ))}
              </select>
            </div>

            {/*
              Vitesse, volume, voix propre, dictionnaire de prononciation et émotion ne réglaient que l'ancienne
              synthèse Cartesia : la voix des appels (ElevenLabs) les ignore, et le champ « ID voix Cartesia »
              n'a plus de sens pour un restaurateur. Les valeurs déjà enregistrées sont conservées et renvoyées
              telles quelles à l'enregistrement ; les commandes reviendront avec un réglage ElevenLabs réel.
            */}

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Instructions personnalisées
                <span className="ml-1 text-xs text-muted-foreground">
                  (max {SYSTEM_PROMPT_EXTRA_MAX_LENGTH} caractères)
                </span>
              </label>
              <textarea
                value={systemPromptExtra}
                onChange={(e) => {
                  setSystemPromptExtra(e.target.value);
                  setSavedPersonality(false);
                }}
                maxLength={SYSTEM_PROMPT_EXTRA_MAX_LENGTH}
                rows={4}
                placeholder="Ex : nous avons une offre spéciale le mercredi soir. Proposez-la si le client le demande."
                className="flex w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <p className="text-right text-xs text-muted-foreground">
                {systemPromptExtra.length}/{SYSTEM_PROMPT_EXTRA_MAX_LENGTH}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={savingPersonality}>
                <Bot size={16} className="mr-1" />
                {savingPersonality ? 'Enregistrement...' : 'Enregistrer la personnalité'}
              </Button>
              {savedPersonality && (
                <span className="flex items-center gap-1 text-sm text-primary">
                  <CheckCircle2 size={16} />
                  Personnalité enregistrée
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
