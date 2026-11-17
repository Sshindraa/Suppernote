'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { getPlanSignupHref, readPricingSelection } from '@/app/pricing-links';

const ENDPOINT = '/api/proxy/public/demo-requests';
const PAGE_VERSION = 'demo-2026-10';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error' | 'invalid';

const FIELD_CLASS =
  'h-11 rounded-xl border-white/10 bg-background/60 text-sm transition-all duration-200';

/**
 * Demande de démonstration : aucun compte requis. La clé d'idempotence est créée une fois par
 * formulaire, pour qu'un nouvel essai après erreur ne crée jamais un second prospect.
 */
export default function DemoRequestForm() {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [selection, setSelection] = useState<ReturnType<typeof readPricingSelection>>(null);
  useEffect(() => {
    setSelection(readPricingSelection(window.location.search));
  }, []);
  const [fromVoiceSolution, setFromVoiceSolution] = useState(false);
  useEffect(() => {
    setFromVoiceSolution(
      new URLSearchParams(window.location.search).get('source') === 'assistant-telephonique',
    );
  }, []);
  const [status, setStatus] = useState<FormStatus>('idle');
  const inFlight = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || status === 'success') return;

    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const payload = {
      idempotencyKey,
      establishmentName: text('establishmentName'),
      contactEmail: text('contactEmail'),
      contactPhone: text('contactPhone') || undefined,
      currentTool: text('currentTool') || undefined,
      mainProblem: text('mainProblem') || undefined,
      pageVersion: fromVoiceSolution
        ? 'demo-assistant-tel-v1'
        : selection
          ? `demo-${selection.plan === 'Multi-restaurant' ? 'multi-site' : selection.plan.toLowerCase()}-${selection.yearly ? 'annual' : 'monthly'}${selection.plan === 'Multi-restaurant' ? `-${selection.siteCount}` : ''}-2026-10`
          : PAGE_VERSION,
      website: text('website') || undefined,
    };

    inFlight.current = true;
    setStatus('submitting');
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 400) {
        setStatus('invalid');
      } else if (!response.ok) {
        setStatus('error');
      } else {
        setStatus('success');
      }
    } catch {
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }

  if (status === 'success') {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full border border-success/30 bg-success/10 text-success">
          <CheckCircle2 size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-brand text-2xl font-medium text-foreground">
            Demande bien enregistrée
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Nous vous recontactons par e-mail pour convenir d’un créneau de démonstration.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Vous souhaitez déjà utiliser Suppernote ?{' '}
          <Link
            href={
              selection
                ? getPlanSignupHref(selection.plan, selection.yearly, selection.siteCount)
                : '/register'
            }
            className="font-medium text-foreground underline underline-offset-4"
          >
            Créer votre compte
          </Link>
        </p>
      </div>
    );
  }

  const submitting = status === 'submitting';

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {selection && (
        <p className="text-sm text-muted-foreground">
          Votre demande concerne {selection.plan}, en facturation{' '}
          {selection.yearly ? 'annuelle' : 'mensuelle'}
          {selection.plan === 'Multi-restaurant'
            ? `, pour ${selection.siteCount} ${selection.siteCount === 1 ? 'établissement' : 'établissements'}`
            : ''}
          . Votre choix sera conservé à l’inscription.
        </p>
      )}
      <div className="grid gap-2">
        <Label htmlFor="establishmentName">Nom de votre établissement</Label>
        <Input
          id="establishmentName"
          name="establishmentName"
          autoComplete="organization"
          required
          maxLength={120}
          disabled={submitting}
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="contactEmail">Adresse e-mail professionnelle</Label>
        <Input
          id="contactEmail"
          name="contactEmail"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          disabled={submitting}
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="contactPhone">Téléphone (facultatif)</Label>
        <Input
          id="contactPhone"
          name="contactPhone"
          type="tel"
          autoComplete="tel"
          maxLength={32}
          disabled={submitting}
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="currentTool">Outil ou méthode actuelle (facultatif)</Label>
        <Input
          id="currentTool"
          name="currentTool"
          placeholder="Cahier, tableur, autre logiciel…"
          maxLength={120}
          disabled={submitting}
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="mainProblem">Problème principal (facultatif)</Label>
        <textarea
          id="mainProblem"
          name="mainProblem"
          rows={3}
          maxLength={500}
          disabled={submitting}
          className="flex w-full rounded-xl border border-white/10 bg-background/60 px-3 py-2 text-sm text-foreground transition-all duration-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        />
      </div>

      {/* Champ piège : invisible pour une personne, rempli par les robots. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Site web</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          Votre demande n’a pas pu être enregistrée. Vérifiez votre connexion, puis réessayez.
        </p>
      )}
      {status === 'invalid' && (
        <p role="alert" className="text-sm text-destructive">
          Vérifiez les informations saisies : le nom de l’établissement et une adresse e-mail valide
          sont nécessaires.
        </p>
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        Nous utilisons ces informations uniquement pour vous recontacter au sujet de la
        démonstration. Consultez notre{' '}
        <a href="/privacy" className="underline underline-offset-4">
          politique de confidentialité
        </a>
        .
      </p>

      <Button
        type="submit"
        disabled={submitting}
        className={cn(
          'h-11 w-full rounded-full text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5',
        )}
      >
        {submitting ? 'Envoi en cours…' : 'Demander une démonstration'}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Vous préférez créer votre compte tout de suite ?{' '}
        <Link
          href={
            selection
              ? getPlanSignupHref(selection.plan, selection.yearly, selection.siteCount)
              : '/register'
          }
          className="font-medium text-foreground underline underline-offset-4"
        >
          Créer votre compte
        </Link>
      </p>
    </form>
  );
}
