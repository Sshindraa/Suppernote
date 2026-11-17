'use client';

import { useCallback, useEffect, useState } from 'react';
import { getErrorMessage } from '@/types/api';
import type { useApi } from '@/lib/api';
import {
  analyseWebsite,
  fetchHeartbeats,
  needsFallback as analysisNeedsFallback,
  pickDefaultChoice,
  type FallbackAnswer,
  type Heartbeat,
  type InstallChoice,
  type WebsiteCheckResult,
} from './website-check';

type Api = Pick<ReturnType<typeof useApi>, 'get' | 'post'>;

export function useWebsiteCheck({
  api,
  initialUrl,
  enabled,
}: {
  api: Api;
  initialUrl: string;
  enabled: boolean;
}) {
  const { get, post } = api;
  const [url, setUrl] = useState(initialUrl);
  const [analysis, setAnalysis] = useState<WebsiteCheckResult | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // null = le restaurateur n'a pas encore touché au choix : on suit la recommandation.
  const [userChoice, setUserChoice] = useState<InstallChoice | null>(null);
  const [answer, setAnswer] = useState<FallbackAnswer>(null);
  const [heartbeats, setHeartbeats] = useState<Heartbeat[] | null>(null);
  const [heartbeatsError, setHeartbeatsError] = useState<string | null>(null);

  const loadHeartbeats = useCallback(async () => {
    try {
      setHeartbeats(await fetchHeartbeats({ get, post }));
      setHeartbeatsError(null);
    } catch (err: unknown) {
      setHeartbeatsError(
        getErrorMessage(err, 'Impossible de charger le statut de l’installation.'),
      );
    }
  }, [get, post]);

  useEffect(() => {
    if (!enabled) return;
    fetchHeartbeats({ get, post }).then(
      (list) => {
        setHeartbeats(list);
        setHeartbeatsError(null);
      },
      (err: unknown) =>
        setHeartbeatsError(
          getErrorMessage(err, 'Impossible de charger le statut de l’installation.'),
        ),
    );
  }, [enabled, get, post]);

  const analyse = useCallback(
    async (target: string) => {
      setAnalysing(true);
      setAnalysisError(null);
      try {
        setAnalysis(await analyseWebsite({ get, post }, target.trim()));
        setUserChoice(null);
        setAnswer(null);
        await loadHeartbeats();
      } catch (err: unknown) {
        setAnalysisError(getErrorMessage(err, 'Impossible d’analyser votre site.'));
      } finally {
        setAnalysing(false);
      }
    },
    [get, post, loadHeartbeats],
  );

  const recommended = pickDefaultChoice(analysis, answer);

  return {
    url,
    setUrl,
    analysis,
    analysing,
    analysisError,
    analyse: () => analyse(url),
    needsFallback: analysisNeedsFallback(analysis),
    answer,
    setAnswer,
    recommended,
    choice: userChoice ?? recommended,
    setChoice: setUserChoice,
    heartbeats,
    heartbeatsError,
    reloadHeartbeats: loadHeartbeats,
  };
}
