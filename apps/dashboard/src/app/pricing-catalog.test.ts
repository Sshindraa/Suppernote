import { describe, expect, it } from 'vitest';
import {
  CATALOG_FEATURES,
  PLAN_ORDER,
  featuresIncludedIn,
  featuresIntroducedIn,
  planIncludes,
} from './pricing-catalog';

describe('catalogue des fonctionnalités', () => {
  it('ne contient que des fonctionnalités disponibles ou prévues', () => {
    for (const feature of CATALOG_FEATURES) {
      expect(['disponible', 'prévu']).toContain(feature.status);
    }
  });

  it('inclut à chaque formule tout ce qui est introduit à son rang ou en dessous', () => {
    const essentialOnly = featuresIntroducedIn('Essential');
    const proOnly = featuresIntroducedIn('Pro');

    expect(featuresIncludedIn('Essential')).toEqual(essentialOnly);
    expect(featuresIncludedIn('Pro')).toEqual([...essentialOnly, ...proOnly]);
    expect(featuresIncludedIn('Multi-restaurant')).toHaveLength(CATALOG_FEATURES.length);
  });

  it("n'inclut pas une fonctionnalité d'une formule supérieure", () => {
    const proFeature = featuresIntroducedIn('Pro')[0];

    expect(planIncludes('Essential', proFeature)).toBe(false);
    expect(planIncludes('Pro', proFeature)).toBe(true);
    expect(planIncludes('Multi-restaurant', proFeature)).toBe(true);
  });

  it('marque comme prévues les intégrations non livrées, jamais comme disponibles', () => {
    const planned = CATALOG_FEATURES.filter((feature) => feature.status === 'prévu');
    const labels = planned.map((feature) => feature.label);

    expect(labels).toEqual(expect.arrayContaining(['Réservation depuis ChatGPT et Claude']));
    expect(
      CATALOG_FEATURES.filter((feature) => feature.status === 'disponible').map((f) => f.label),
    ).toEqual(expect.arrayContaining(['Synchronisation ZenChef, TheFork, Lightspeed']));
  });

  it('ne présente comme disponible ni la comparaison consolidée ni le partage des profils clients', () => {
    const available = CATALOG_FEATURES.filter((feature) => feature.status === 'disponible');

    expect(available.map((feature) => feature.label).join(' ')).not.toMatch(
      /comparaison consolidée|profils clients partagés/i,
    );
  });

  it('garde le suivi des absences dans la formule Essential, comme la page Tarifs', () => {
    expect(featuresIntroducedIn('Essential').map((feature) => feature.label)).toContain(
      'Fichier client et suivi des absences',
    );
  });

  it('inclut la reconnaissance des habitués dès Essential, disponible', () => {
    const feature = CATALOG_FEATURES.find((item) => item.id === 'returning-callers');
    expect(feature).toEqual(
      expect.objectContaining({ introducedIn: 'Essential', status: 'disponible' }),
    );
  });

  it('réserve le copilote de service à Pro et Multi-restaurant, jamais à Essential', () => {
    const copilot = CATALOG_FEATURES.filter((feature) => feature.id.startsWith('copilot-'));

    expect(copilot.length).toBeGreaterThan(0);
    for (const feature of copilot) {
      expect(feature.introducedIn).toBe('Pro');
    }
    expect(
      featuresIncludedIn('Essential').some((feature) => feature.id.startsWith('copilot-')),
    ).toBe(false);
  });

  it('couvre les trois formules dans l’ordre d’affichage', () => {
    expect(PLAN_ORDER).toEqual(['Essential', 'Pro', 'Multi-restaurant']);
  });
});
