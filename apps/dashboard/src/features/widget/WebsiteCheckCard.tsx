'use client';

import type { ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  bookingTargetLabel,
  FETCH_ERROR_MESSAGES,
  findCompetitors,
  PLATFORM_LABELS,
  type FallbackAnswer,
  type WebsiteCheckResult,
} from './website-check';

type Props = {
  url: string;
  onUrlChange: (url: string) => void;
  onAnalyse: () => void;
  analysing: boolean;
  analysisError: string | null;
  analysis: WebsiteCheckResult | null;
  needsFallback: boolean;
  answer: FallbackAnswer;
  onAnswer: (answer: FallbackAnswer) => void;
};

function Warning({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
      {children}
    </p>
  );
}

function AnswerButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
      className="transition-all duration-200"
    >
      {children}
    </Button>
  );
}

function AnalysisResult({ analysis }: { analysis: WebsiteCheckResult }) {
  const competitors = findCompetitors(analysis);
  const count = analysis.bookingLinks.length;

  if (analysis.fetchError) {
    return <Warning>{FETCH_ERROR_MESSAGES[analysis.fetchError]}</Warning>;
  }

  return (
    <div className="space-y-3 text-sm">
      <p>
        {analysis.platform === 'unknown'
          ? 'Nous n’avons pas reconnu l’outil de votre site.'
          : `Plateforme repérée : ${PLATFORM_LABELS[analysis.platform]}.`}
      </p>
      {count > 0 ? (
        <div className="space-y-2">
          <p className="font-medium">
            {count} bouton{count > 1 ? 's' : ''} Réserver trouvé{count > 1 ? 's' : ''}
          </p>
          <ul className="space-y-1.5 text-muted-foreground">
            {analysis.bookingLinks.map((link, index) => (
              <li key={`${link.href}-${index}`} className="break-words">
                « {link.text || 'sans texte'} » mène vers {bookingTargetLabel(link.target)}
                <span className="block font-mono text-xs break-all">{link.href}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">Aucun bouton Réserver trouvé sur cette page.</p>
      )}
      {competitors.map((name) => (
        <Warning key={name}>
          Retirez l’ancien module {name} pour éviter des réservations en double.
        </Warning>
      ))}
      {analysis.framingBlocked === true && (
        <Warning>
          Votre site empêche d’afficher le formulaire dans une autre page. Gardez plutôt vos boutons
          Réserver, ou demandez à votre webmaster de l’autoriser.
        </Warning>
      )}
      {analysis.scriptFound && analysis.slugMatches === true && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          Le code Suppernote est déjà présent sur votre site.
        </p>
      )}
      {analysis.scriptFound && analysis.slugMatches === false && (
        <Warning>
          Le code Suppernote présent sur votre site ne correspond pas à votre restaurant.
        </Warning>
      )}
    </div>
  );
}

export function WebsiteCheckCard({
  url,
  onUrlChange,
  onAnalyse,
  analysing,
  analysisError,
  analysis,
  needsFallback,
  answer,
  onAnswer,
}: Props) {
  return (
    <section aria-labelledby="website-check-title" className="space-y-4">
      <h2 id="website-check-title" className="text-base font-semibold">
        Votre site
      </h2>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() && !analysing) onAnalyse();
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor="website-url" className="text-sm font-medium">
            Adresse de votre site
          </label>
          <Input
            id="website-url"
            type="text"
            inputMode="url"
            placeholder="https://www.votre-restaurant.fr"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            className="transition-all duration-200"
          />
        </div>
        <div className="flex items-end">
          <Button
            type="submit"
            disabled={!url.trim() || analysing}
            className="w-full transition-all duration-200 sm:w-auto"
          >
            {analysing ? 'Analyse en cours…' : 'Analyser mon site'}
          </Button>
        </div>
      </form>

      {analysing && (
        <p role="status" className="text-sm text-muted-foreground">
          Lecture de votre site en cours, cela peut prendre quelques secondes.
        </p>
      )}
      {analysisError && <Warning>{analysisError}</Warning>}
      {analysis && !analysing && <AnalysisResult analysis={analysis} />}

      {needsFallback && !analysing && (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-sm font-medium">Avez-vous déjà un bouton Réserver sur votre site ?</p>
          <div className="flex gap-2">
            <AnswerButton active={answer === 'yes'} onClick={() => onAnswer('yes')}>
              Oui
            </AnswerButton>
            <AnswerButton active={answer === 'no'} onClick={() => onAnswer('no')}>
              Non
            </AnswerButton>
          </div>
        </div>
      )}
    </section>
  );
}
