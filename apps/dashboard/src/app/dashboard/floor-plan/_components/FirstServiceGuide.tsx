'use client';

import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const FIRST_SERVICE_GUIDE_STORAGE_KEY = 'sokar:first-service-guide:dismissed';

/**
 * Encart discret affiché la première fois que le restaurateur ouvre le plan en mode service : il
 * nomme les deux gestes de la salle. La fermeture est mémorisée dans le navigateur ; si le stockage
 * est indisponible (navigation privée, données bloquées), l'encart s'affiche et se ferme quand même
 * normalement, il reviendra simplement au prochain chargement.
 */
export function FirstServiceGuide() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(FIRST_SERVICE_GUIDE_STORAGE_KEY) === '1';
    } catch {
      // Stockage indisponible : le guide s'affiche.
    }
    setVisible(!dismissed);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(FIRST_SERVICE_GUIDE_STORAGE_KEY, '1');
    } catch {
      // Rien à faire : l'encart est déjà fermé pour cette visite.
    }
  };

  return (
    <aside
      aria-label="Guide du premier service"
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4 transition-all duration-200 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-full bg-background p-1.5 text-muted-foreground">
          <Lightbulb size={14} aria-hidden="true" />
        </span>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Votre premier service</p>
          <p>
            Un client arrive sans réservation : touchez une table libre, puis{' '}
            <strong className="font-medium text-foreground">Walk-in</strong>. La table n’est plus
            proposée au téléphone ni en ligne.
          </p>
          <p>
            Quand il part, touchez sa table puis{' '}
            <strong className="font-medium text-foreground">Libérer la table</strong> : elle
            redevient réservable tout de suite.
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={dismiss}
        className="shrink-0 self-start transition-all duration-200 sm:self-center"
      >
        Compris
      </Button>
    </aside>
  );
}
