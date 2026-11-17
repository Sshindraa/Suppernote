'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useWebsiteCheck } from './use-website-check';
import { WebsiteCheckCard } from './WebsiteCheckCard';
import { InstallOptions } from './InstallOptions';
import { InstallStatusCard } from './InstallStatusCard';
import type { useApi } from '@/lib/api';

type Props = {
  slug: string;
  websiteUrl?: string | null;
  api: Pick<ReturnType<typeof useApi>, 'get' | 'post'>;
};

/** Parcours complet : analyser le site, choisir le mode, transmettre, vérifier l'installation. */
export function WidgetSetup({ slug, websiteUrl, api }: Props) {
  const check = useWebsiteCheck({ api, initialUrl: websiteUrl ?? '', enabled: true });
  const platform = check.analysis?.platform ?? 'unknown';

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <WebsiteCheckCard
            url={check.url}
            onUrlChange={check.setUrl}
            onAnalyse={check.analyse}
            analysing={check.analysing}
            analysisError={check.analysisError}
            analysis={check.analysis}
            needsFallback={check.needsFallback}
            answer={check.answer}
            onAnswer={check.setAnswer}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <InstallOptions
            slug={slug}
            choice={check.choice}
            onChoiceChange={check.setChoice}
            recommended={check.recommended}
            needsFallback={check.needsFallback}
            platform={platform}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <InstallStatusCard
            heartbeats={check.heartbeats}
            heartbeatsError={check.heartbeatsError}
            canVerify={check.url.trim().length > 0}
            verifying={check.analysing}
            onVerify={check.analyse}
          />
        </CardContent>
      </Card>
    </div>
  );
}
