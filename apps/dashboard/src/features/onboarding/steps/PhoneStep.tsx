'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { normalizePhone } from '@suppernote/shared';
import {
  ArrowLeft,
  ArrowRight,
  Headphones,
  Info,
  Check,
  Copy,
  Loader2,
  Phone,
  PhoneForwarded,
  Pencil,
  Router,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { useOnboarding } from '../onboarding-provider';
import { StepHeader, OnboardingAction } from '../ui';
import { FitToHeight } from '../fit-to-height';
import { isValidPhoneInput, toNationalDisplay } from '../phone-format';
import type { StepProps } from '../types';
import { ONBOARDING_STEP_DELAY_MS } from '@/constants/ui';

type LineType = 'mobile' | 'fixed' | 'box';

const LINE_TYPES: Array<{ value: LineType; label: string; icon: typeof Phone }> = [
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
  { value: 'fixed', label: 'Ligne fixe', icon: Phone },
  { value: 'box', label: 'Box internet', icon: Router },
];

/** Sous-étape discrète : la seule numérotation appuyée reste celle du parcours en haut. */
function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-semibold text-muted-foreground">
      {n}
    </span>
  );
}

/**
 * Le plan de numérotation français indique la ligne : 06/07 mobile, 09 box (VoIP des opérateurs),
 * 01 à 05 géographique (ligne classique, ou numéro conservé sur une box). Hors de France : pas d'avis.
 */
function detectLineType(e164: string): LineType | null {
  if (/^\+33[67]\d{8}$/.test(e164)) return 'mobile';
  if (/^\+339\d{8}$/.test(e164)) return 'box';
  if (/^\+33[1-5]\d{8}$/.test(e164)) return 'fixed';
  return null;
}

/** +33 1 23 45 67 89 → 01 23 45 67 89 : les lignes fixes se composent au format national. */
function toNational(e164: string) {
  return e164.startsWith('+33') ? `0${e164.slice(3)}` : e164;
}

/** +33123456789 → ['+33', '1', '23', '45', '67', '89'] : des blocs faciles à recopier sur un clavier. */
function digitGroups(number: string) {
  if (/^\+33\d{9}$/.test(number)) {
    return ['+33', number[3], ...(number.slice(4).match(/\d{2}/g) ?? [])];
  }
  if (/^0\d{9}$/.test(number)) return number.match(/\d{2}/g) ?? [number];
  return [number];
}

/** Le geste exact pour activer le renvoi, avec le numéro Suppernote déjà rempli. */
function lineGuide(type: LineType, assistantPhoneNumber: string) {
  if (type === 'mobile') {
    return {
      title: 'Depuis le téléphone du restaurant, composez ces caractères à la suite, puis appelez.',
      code: `**21*${assistantPhoneNumber}#`,
      parts: ['**21*', assistantPhoneNumber, '#'],
      help: 'Un message de l’opérateur confirme l’activation.',
      stop: '##21#',
    };
  }
  if (type === 'fixed') {
    return {
      title: 'Depuis la ligne fixe du restaurant, composez ces caractères à la suite.',
      code: `*21*${toNational(assistantPhoneNumber)}#`,
      parts: ['*21*', toNational(assistantPhoneNumber), '#'],
      help: 'Si le code n’est pas reconnu, activez le renvoi depuis l’espace client de votre opérateur.',
      stop: '#21#',
    };
  }
  return {
    title: 'Activez le renvoi dans l’espace client de votre opérateur.',
    code: '',
    parts: ['', assistantPhoneNumber, ''],
    help: `Rubrique « Renvoi d’appel » de votre abonnement, vers le ${toNationalDisplay(assistantPhoneNumber)}. Le code à composer dépend de l’opérateur.`,
    stop: '',
  };
}

export function PhoneStep({ onComplete }: StepProps) {
  const { state, updateTask, setRestaurantDraft, placeImportDraft } = useOnboarding();
  const { post, patch, orgId } = useApi();
  const [calling, setCalling] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // Choix explicite de l'utilisateur ; sans lui, le type déduit du numéro du restaurant s'applique.
  const [chosenLineType, setChosenLineType] = useState<LineType | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneEdited, setPhoneEdited] = useState(false);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [testCallControlId, setTestCallControlId] = useState<string | null>(null);

  const phoneNumber = state?.restaurant.phoneNumber ?? '';
  const hasAssignedPhone = Boolean(state?.restaurant.phoneAssigned);
  const restaurantPhone = state?.restaurant.phoneE164?.trim() ?? '';
  const persistedTestCallControlId = state?.steps.find((step) => step.key === 'phone')?.state
    .metadata?.testCallControlId;
  const pendingTestCallControlId =
    testCallControlId ??
    (typeof persistedTestCallControlId === 'string' ? persistedTestCallControlId : null);

  // Prérempli par la fiche Google choisie à l'étape 1 (relue après le premier rendu) : il ne reste
  // qu'à valider. Une saisie de l'utilisateur n'est jamais écrasée.
  const googlePhone = placeImportDraft?.phoneE164 ?? '';
  useEffect(() => {
    if (!phoneEdited && googlePhone) setPhoneInput(toNationalDisplay(googlePhone));
  }, [googlePhone, phoneEdited]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy(value: string) {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  /** Le numéro public manque : on le saisit ici plutôt que de renvoyer à l'étape 1. */
  async function handleSaveRestaurantPhone(event: FormEvent) {
    event.preventDefault();
    if (!isValidPhoneInput(phoneInput)) {
      setPhoneError('Saisissez un numéro valide, par exemple 01 23 45 67 89.');
      return;
    }
    const phoneE164 = normalizePhone(phoneInput);
    if (phoneE164 === restaurantPhone) {
      setEditingPhone(false);
      return;
    }
    setSavingPhone(true);
    setPhoneError(null);
    try {
      await patch(`restaurants/${orgId}`, { phoneE164 });
      setRestaurantDraft({ phoneE164 });
      setEditingPhone(false);
    } catch {
      setPhoneError('Impossible d’enregistrer le numéro. Réessayez.');
    } finally {
      setSavingPhone(false);
    }
  }

  function startEditingPhone() {
    setPhoneInput(toNationalDisplay(restaurantPhone));
    setPhoneEdited(true);
    setPhoneError(null);
    setEditingPhone(true);
  }

  function cancelEditingPhone() {
    setPhoneError(null);
    setEditingPhone(false);
  }

  async function handleTestCall() {
    if (!restaurantPhone) {
      setTestError("Numéro du restaurant manquant. Revenez à l'étape « Votre restaurant ».");
      return;
    }
    setCalling(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await post<{ ok: boolean; message: string; callControlId: string }>(
        'restaurant/onboarding/test-call',
        {},
      );
      setTestCallControlId(res.callControlId);
      setTestResult(
        'Appel déclenché. Vérifiez que vous avez bien reçu l’appel et entendu l’assistant, puis confirmez ci-dessous.',
      );
    } catch (err: unknown) {
      // L'API renvoie un code structuré pour différencier les causes d'échec.
      // NO_PHONE_ASSIGNED : action Suppernote (pas un retry utilisateur)
      // TELNYX_FAILED    : erreur réseau/opérateur (réessayer)
      // fallback         : message générique
      const errRecord = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
      const response = errRecord.response as Record<string, unknown> | undefined;
      const responseData = response?.data as Record<string, unknown> | undefined;
      const code = (errRecord.code as string) ?? (responseData?.code as string);
      const apiMessage = (responseData?.error as string) ?? getErrorMessage(err, '');
      if (code === 'NO_PHONE_ASSIGNED') {
        setTestError(
          apiMessage ??
            "Aucun numéro Suppernote attribué. L'appel test vérifie que le renvoi arrive jusqu'à ce numéro : l'équipe Suppernote doit d'abord vous en attribuer un.",
        );
      } else if (code === 'TELNYX_FAILED') {
        setTestError(
          apiMessage ??
            "L'appel test n'a pas pu être déclenché (opérateur injoignable). Réessayez dans quelques minutes.",
        );
      } else {
        setTestError(apiMessage ?? "L'appel test a échoué. Réessayez ou contactez le support.");
      }
    } finally {
      setCalling(false);
    }
  }

  async function handleConfirmTestCall() {
    if (!pendingTestCallControlId) return;
    setCalling(true);
    setTestError(null);
    try {
      const validated = await updateTask('first_call', 'phone', {
        metadata: { testCallControlId: pendingTestCallControlId },
      });
      if (!validated) {
        setTestError("La confirmation n'a pas été enregistrée. Actualisez la page puis réessayez.");
        return;
      }
      const completed = await updateTask('complete', 'phone');
      if (!completed) {
        setTestError('La validation des appels n’a pas été enregistrée. Réessayez.');
        return;
      }
      const activated = await updateTask('activate');
      if (!activated) {
        setTestError('La mise en service n’a pas été enregistrée. Réessayez.');
        return;
      }
      setTestResult('Assistant vocal validé. Votre IA répond maintenant au téléphone.');
      window.setTimeout(() => onComplete(null), ONBOARDING_STEP_DELAY_MS);
    } finally {
      setCalling(false);
    }
  }

  // Pendant une saisie, le numéro tapé prime dès qu'il est reconnaissable.
  const typedPhone = normalizePhone(phoneInput);
  const showPhoneForm = !restaurantPhone || editingPhone;
  const detectionPhone =
    showPhoneForm && (detectLineType(typedPhone) || !restaurantPhone)
      ? typedPhone
      : restaurantPhone;
  const detectedLineType = detectLineType(detectionPhone);
  const lineType = chosenLineType ?? detectedLineType ?? 'mobile';
  const guide = lineGuide(lineType, hasAssignedPhone ? phoneNumber : '');
  const canContinue = hasAssignedPhone && Boolean(restaurantPhone) && !editingPhone;

  return (
    <FitToHeight minZoom={0.75} className="w-full max-w-6xl md:flex-1">
      <StepHeader
        icon={PhoneForwarded}
        title="Votre accueil au téléphone"
        body="Gardez votre numéro. Confiez vos appels à Suppernote."
      />

      <ol
        aria-label="Mise en service des appels"
        className="mb-3 grid grid-cols-2 items-center gap-3 text-xs sm:flex sm:flex-wrap sm:text-sm"
      >
        <li aria-current={!confirmed ? 'step' : undefined} className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-full text-xs font-semibold',
              confirmed ? 'bg-success/10 text-success' : 'bg-foreground text-background',
            )}
          >
            {confirmed ? <Check size={14} aria-hidden /> : '1'}
          </span>
          <span className={cn('font-medium', confirmed && 'text-muted-foreground')}>
            Activer le renvoi
          </span>
        </li>
        <li aria-hidden className="hidden h-px w-12 bg-border sm:block" />
        <li aria-current={confirmed ? 'step' : undefined} className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-full text-xs font-semibold',
              confirmed ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
            )}
          >
            2
          </span>
          <span className={cn('font-medium', !confirmed && 'text-muted-foreground')}>
            Vérifier par un appel
          </span>
        </li>
      </ol>

      <div className="space-y-3">
        <section
          aria-label="Le parcours de vos appels"
          className="flex flex-col gap-4 rounded-[1.75rem] bg-foreground px-5 py-4 text-background xl:flex-row xl:items-center xl:justify-between"
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl border border-background/20 bg-background/10">
              <PhoneForwarded size={19} aria-hidden />
            </span>
            <div>
              <h3 className="text-base font-semibold tracking-tight">
                Votre numéro reste le même.
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-background/70">
                Le renvoi dirige les appels de vos clients vers votre assistant.{' '}
                {guide.stop ? (
                  <>
                    Désactivable à tout moment avec{' '}
                    <code className="font-semibold text-background">{guide.stop}</code>.
                  </>
                ) : (
                  'Désactivable à tout moment depuis votre espace opérateur.'
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-background/15 bg-background/5 px-4 py-2.5 lg:flex-row lg:items-center lg:gap-5 xl:shrink-0">
            <div className="flex items-center gap-3">
              <Phone size={17} className="shrink-0 text-background/60" aria-hidden />
              {!showPhoneForm ? (
                <div className="flex items-center gap-2">
                  <div>
                    <p className="text-xs text-background/60">Vos clients composent</p>
                    <p className="whitespace-nowrap text-sm font-medium tabular-nums">
                      {toNationalDisplay(restaurantPhone)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={startEditingPhone}
                    aria-label="Modifier le numéro du restaurant"
                    className="h-8 rounded-full px-2.5 text-xs text-background/70 transition-all duration-200 hover:bg-background/10 hover:text-background"
                  >
                    <Pencil size={13} aria-hidden />
                    Modifier
                  </Button>
                </div>
              ) : (
                <form
                  onSubmit={handleSaveRestaurantPhone}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && editingPhone) cancelEditingPhone();
                  }}
                  noValidate
                >
                  <label htmlFor="restaurant-public-phone" className="text-xs text-background/60">
                    Numéro du restaurant
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      id="restaurant-public-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="01 23 45 67 89"
                      value={phoneInput}
                      autoFocus={editingPhone}
                      aria-invalid={Boolean(phoneError)}
                      aria-describedby={phoneError ? 'restaurant-public-phone-error' : undefined}
                      onChange={(event) => {
                        setPhoneInput(event.target.value);
                        setPhoneEdited(true);
                        setPhoneError(null);
                      }}
                      className="h-9 w-40 rounded-full border-background/25 bg-background/10 text-sm tabular-nums text-background placeholder:text-background/45 focus-visible:ring-background/40"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={savingPhone}
                      className="h-9 rounded-full bg-background px-3 text-xs text-foreground transition-all duration-200 hover:bg-background/90"
                    >
                      {savingPhone && <Loader2 className="animate-spin" size={14} aria-hidden />}
                      Valider
                    </Button>
                    {editingPhone && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={cancelEditingPhone}
                        aria-label="Annuler la modification"
                        className="size-9 rounded-full p-0 text-background/70 transition-all duration-200 hover:bg-background/10 hover:text-background"
                      >
                        <X size={15} aria-hidden />
                      </Button>
                    )}
                  </div>
                  {phoneError && (
                    <p
                      id="restaurant-public-phone-error"
                      role="alert"
                      className="mt-1 max-w-56 text-xs leading-5 text-background"
                    >
                      {phoneError}
                    </p>
                  )}
                </form>
              )}
            </div>
            <ArrowRight
              size={16}
              className="ml-0.5 rotate-90 text-background/50 lg:ml-0 lg:rotate-0"
              aria-hidden
            />
            <div className="flex items-center gap-3">
              <Headphones size={17} className="shrink-0" aria-hidden />
              <div>
                <p className="text-xs text-background/60">Suppernote répond</p>
                <p className="whitespace-nowrap text-sm font-medium tabular-nums">
                  {hasAssignedPhone ? toNationalDisplay(phoneNumber) : 'Numéro en attente'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div className="min-w-0">
          {!confirmed ? (
            <section
              aria-label="Configuration du renvoi"
              className="rounded-[1.75rem] border border-border bg-card p-5"
            >
              {!hasAssignedPhone ? (
                <div role="status" className="space-y-3">
                  <span className="inline-flex size-10 items-center justify-center rounded-full bg-muted">
                    <Phone size={18} aria-hidden />
                  </span>
                  <h3 className="text-lg font-semibold">
                    Votre numéro Suppernote est en préparation
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    L’équipe Suppernote doit vous attribuer un numéro pour activer le renvoi. Vous
                    pouvez vérifier les autres étapes en attendant.
                  </p>
                </div>
              ) : (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
                  <div className="space-y-3">
                    <h3 className="text-sm font-medium">Votre type de ligne</h3>
                    <div
                      role="group"
                      aria-label="Type de ligne"
                      className="grid grid-cols-3 gap-2 lg:grid-cols-1"
                    >
                      {LINE_TYPES.map((option) => {
                        const Icon = option.icon;
                        const active = lineType === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              setChosenLineType(option.value);
                              if (lineType === option.value) return;
                              setCopied(false);
                              setCopyError(false);
                            }}
                            className={cn(
                              'relative flex min-h-12 flex-col items-center justify-center gap-2 rounded-2xl border px-3 py-2.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:flex-row sm:text-sm lg:justify-start',
                              active
                                ? 'border-foreground bg-foreground text-background shadow-sm'
                                : 'border-border text-muted-foreground hover:border-foreground/30 hover:bg-muted/50 hover:text-foreground',
                            )}
                          >
                            <Icon size={18} aria-hidden />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    {detectedLineType && !chosenLineType && (
                      <p className="text-xs leading-5 text-muted-foreground">
                        Déduit de votre numéro{' '}
                        <span className="whitespace-nowrap">
                          {toNationalDisplay(detectionPhone)}
                        </span>
                        .
                        {detectedLineType === 'fixed' &&
                          ' Téléphone branché sur une box\u00a0? Choisissez Box internet.'}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0 space-y-3">
                    <div>
                      <h3 className="text-sm font-medium">
                        {guide.code ? 'Code à composer' : 'Numéro de destination'}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{guide.title}</p>
                    </div>
                    <div className="rounded-2xl border border-border bg-muted/40 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <code className="font-mono text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                          <span className="sr-only">{guide.code || phoneNumber}</span>
                          <span aria-hidden className="flex flex-wrap items-baseline gap-x-2">
                            {guide.parts[0] && <span>{guide.parts[0]}</span>}
                            <span className="flex flex-wrap gap-x-1.5">
                              {digitGroups(guide.parts[1]).map((group, index) => (
                                <span key={index}>{group}</span>
                              ))}
                            </span>
                            {guide.parts[2] && <span>{guide.parts[2]}</span>}
                          </span>
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={
                            copied ? 'Copié' : guide.code ? 'Copier le code' : 'Copier le numéro'
                          }
                          onClick={() => handleCopy(guide.code || phoneNumber)}
                          className="h-9 shrink-0 rounded-full bg-card px-3 text-xs transition-all duration-200"
                        >
                          {copied ? (
                            <Check size={14} aria-hidden />
                          ) : (
                            <Copy size={14} aria-hidden />
                          )}
                          {copied ? 'Copié' : 'Copier'}
                        </Button>
                      </div>
                      <p role="status" className="sr-only">
                        {copied ? 'Copie effectuée.' : ''}
                      </p>
                      {copyError && (
                        <p role="alert" className="mt-3 text-sm text-destructive">
                          La copie n’a pas fonctionné. Sélectionnez le texte pour le copier ou
                          composez-le directement.
                        </p>
                      )}
                    </div>
                    <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
                      {guide.help}
                    </p>
                  </div>
                </div>
              )}
            </section>
          ) : (
            <section
              aria-label="Vérification par un appel"
              className="space-y-4 rounded-[1.75rem] border border-border bg-card p-5"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-success">
                <Check size={15} aria-hidden />
                Code de renvoi composé
              </div>
              <div>
                <h3 className="text-xl font-semibold tracking-tight">Place au premier appel.</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Lancez le test vers le numéro du restaurant. Vérifiez que vous recevez l’appel et
                  entendez l’assistant, puis confirmez.
                </p>
              </div>
              <ol className="space-y-3 rounded-2xl bg-muted/40 p-4 text-sm">
                <li className="flex items-center gap-3">
                  <StepBadge n={1} />
                  Lancez un appel test.
                </li>
                <li className="flex items-center gap-3">
                  <StepBadge n={2} />
                  Écoutez l’assistant répondre.
                </li>
                <li className="flex items-center gap-3">
                  <StepBadge n={3} />
                  Confirmez la réception de l’appel.
                </li>
              </ol>
              {testResult && (
                <p
                  role="status"
                  className="rounded-xl border border-success/30 bg-success/5 p-4 text-sm leading-6 text-success"
                >
                  {testResult}
                </p>
              )}
              {testError && (
                <p
                  role="alert"
                  className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-destructive"
                >
                  {testError}
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={calling}
                onClick={() => setConfirmed(false)}
                className="px-0 text-muted-foreground transition-all duration-200"
              >
                <ArrowLeft size={14} aria-hidden />
                Revoir les instructions de renvoi
              </Button>
            </section>
          )}
        </div>
      </div>

      <OnboardingAction>
        {!confirmed ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p id="phone-next-hint" className="max-w-60 text-xs leading-5 text-muted-foreground">
              {!hasAssignedPhone
                ? 'En attente de votre numéro Suppernote.'
                : showPhoneForm
                  ? phoneInput.trim()
                    ? 'Validez d’abord le numéro du restaurant.'
                    : 'Renseignez d’abord le numéro du restaurant.'
                  : 'Un appel test vérifiera le renvoi.'}
            </p>
            <Button
              type="button"
              onClick={() => setConfirmed(true)}
              disabled={!canContinue}
              aria-describedby="phone-next-hint"
              className="h-11 rounded-full px-5 transition-all duration-200"
            >
              {lineType === 'box' ? 'J’ai activé le renvoi' : 'J’ai composé le code'}
              <ArrowRight size={16} aria-hidden />
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            {pendingTestCallControlId ? (
              <>
                <Button
                  type="button"
                  onClick={handleTestCall}
                  disabled={calling || !hasAssignedPhone || !restaurantPhone || editingPhone}
                  variant="outline"
                  className="rounded-full transition-all duration-200"
                >
                  Relancer l’appel test
                  <PhoneForwarded size={16} aria-hidden />
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirmTestCall}
                  disabled={calling}
                  className="rounded-full transition-all duration-200"
                >
                  {calling && <Loader2 className="animate-spin" size={16} aria-hidden />}
                  {calling ? 'Confirmation en cours…' : "J'ai reçu l'appel"}
                  <ShieldCheck size={16} aria-hidden />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={handleTestCall}
                disabled={calling || !hasAssignedPhone || !restaurantPhone || editingPhone}
                className="rounded-full transition-all duration-200"
              >
                {calling && <Loader2 className="animate-spin" size={16} aria-hidden />}
                {calling ? 'Appel en cours…' : 'Lancer un appel test'}
                <PhoneForwarded size={16} aria-hidden />
              </Button>
            )}
          </div>
        )}
      </OnboardingAction>
    </FitToHeight>
  );
}
