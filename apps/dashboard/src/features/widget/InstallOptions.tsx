'use client';

import { useState, type ReactNode } from 'react';
import { CheckCircle2, Copy, Info, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CLIPBOARD_RESET_DELAY_MS } from '@/constants/ui';
import { buildWidgetPreviewUrl } from '@/lib/widget-preview-url';
import {
  buildWidgetSnippet,
  WIDGET_DEFAULT_ACCENT,
  WIDGET_DEFAULT_PRIMARY,
} from '@/lib/widget-snippet';
import { cn } from '@/lib/utils';
import {
  buildBookingUrl,
  buildEmbedScriptLine,
  buildWebmasterMailto,
  platformSteps,
  PLATFORM_LABELS,
  type InstallChoice,
  type WebsitePlatform,
} from './website-check';

type Props = {
  slug: string;
  choice: InstallChoice;
  onChoiceChange: (choice: InstallChoice) => void;
  recommended: InstallChoice;
  needsFallback: boolean;
  platform: WebsitePlatform;
};

function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex text-muted-foreground transition-all duration-200 hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), CLIPBOARD_RESET_DELAY_MS);
    } catch {
      toast.error('Impossible de copier. Sélectionnez le texte manuellement.');
    }
  }
  return { copied, copy };
}

function ChoiceButton({
  active,
  recommended,
  onClick,
  children,
}: {
  active: boolean;
  recommended?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-all duration-200',
        active
          ? 'bg-foreground text-background'
          : 'bg-muted/60 text-foreground/75 hover:bg-foreground/10',
      )}
    >
      {children}
      {recommended && (
        <span className="rounded-full bg-background/20 px-1.5 text-xs font-normal">Recommandé</span>
      )}
    </button>
  );
}

function ButtonsOption({ slug }: { slug: string }) {
  const { copied, copy } = useCopy();
  const link = buildBookingUrl(slug);
  const script = buildEmbedScriptLine(slug);
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground/85">
        Remplacez le lien de vos boutons « Réserver » par celui-ci.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          readOnly
          value={link}
          aria-label="Lien de réservation"
          className="font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void copy('link', link)}
          className="shrink-0 gap-2 transition-all duration-200"
        >
          {copied === 'link' ? <CheckCircle2 size={16} /> : <Copy size={16} />}
          {copied === 'link' ? 'Lien copié' : 'Copier le lien'}
        </Button>
      </div>
      <details className="group rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium transition-all duration-200">
          Voir le code
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Ajoutez cette ligne une seule fois dans les pages de votre site, avant la balise «
            &lt;/body&gt; ». Elle permet d’ouvrir la réservation dans une fenêtre.
          </p>
          <code className="block break-all rounded-md bg-muted/50 p-3 font-mono text-xs">
            {script}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy('script', script)}
            className="gap-2 transition-all duration-200"
          >
            {copied === 'script' ? <CheckCircle2 size={15} /> : <Copy size={15} />}
            {copied === 'script' ? 'Ligne copiée' : 'Copier la ligne'}
          </Button>
        </div>
      </details>
    </div>
  );
}

function FormOption({ slug }: { slug: string }) {
  const { copied, copy } = useCopy();
  const snippet = buildWidgetSnippet(slug);
  const previewUrl = buildWidgetPreviewUrl(slug, WIDGET_DEFAULT_PRIMARY, WIDGET_DEFAULT_ACCENT);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Code à intégrer</h3>
        <div className="space-y-2">
          <label htmlFor="snippet" className="text-sm font-medium">
            Code du widget
          </label>
          {/* Le code entier, sans défilement : rows couvre les navigateurs sans field-sizing. */}
          <textarea
            id="snippet"
            readOnly
            rows={Math.ceil(snippet.length / 30)}
            value={snippet}
            className="block w-full resize-none break-all rounded-md border border-input bg-background px-3 py-2 font-mono text-xs [field-sizing:content] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Button
          type="button"
          onClick={() => void copy('form', snippet)}
          className="w-full gap-2 transition-all duration-200"
        >
          {copied === 'form' ? <CheckCircle2 size={16} /> : <Copy size={16} />}
          {copied === 'form' ? 'Code copié' : 'Copier le code'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Collez ce code dans le HTML de votre site, à l’endroit où le formulaire doit apparaître.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Aperçu
          <InfoTip label="Précision sur la hauteur">
            La hauteur s’adapte automatiquement sur votre site grâce au script /embed.js.
          </InfoTip>
        </h3>
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <iframe
            src={previewUrl}
            title="Aperçu du widget Suppernote"
            className="w-full"
            style={{ height: 520 }}
            scrolling="no"
          />
        </div>
      </div>
    </div>
  );
}

export function InstallOptions({
  slug,
  choice,
  onChoiceChange,
  recommended,
  needsFallback,
  platform,
}: Props) {
  const steps = platformSteps(platform);
  return (
    <section aria-labelledby="install-title" className="space-y-5">
      <h2 id="install-title" className="text-base font-semibold">
        Installation
      </h2>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {needsFallback
            ? 'Garder ce bouton ou afficher le formulaire ?'
            : 'Que voulez-vous faire ?'}
        </p>
        <div role="group" aria-label="Mode d’installation" className="flex flex-wrap gap-2">
          <ChoiceButton
            active={choice === 'buttons'}
            recommended={recommended === 'buttons'}
            onClick={() => onChoiceChange('buttons')}
          >
            Garder vos boutons
          </ChoiceButton>
          <ChoiceButton active={choice === 'form'} onClick={() => onChoiceChange('form')}>
            Afficher le formulaire sur votre page
          </ChoiceButton>
        </div>
      </div>

      {choice === 'buttons' ? <ButtonsOption slug={slug} /> : <FormOption slug={slug} />}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {platform === 'unknown' ? 'Étapes à suivre' : `Étapes sur ${PLATFORM_LABELS[platform]}`}
        </h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-6 text-foreground/85">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      <Button
        asChild
        variant="outline"
        className="w-full gap-2 transition-all duration-200 sm:w-auto"
      >
        <a href={buildWebmasterMailto(slug, choice, platform)}>
          <Mail size={16} />
          Transmettre à mon webmaster
        </a>
      </Button>
    </section>
  );
}
