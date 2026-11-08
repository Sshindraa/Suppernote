import { describe, expect, it } from 'vitest';
import {
  FALSE_ALARM_PROBABILITY,
  MIN_BASELINE_EVENTS,
  dailySpend,
  errorRateVerdict,
  poissonTailAtLeast,
  runwayDays,
  runwayLevel,
} from '../alert-math';

describe('loi de Poisson', () => {
  it('P(X ≥ 0) = 1 et décroît avec le nombre d’erreurs', () => {
    expect(poissonTailAtLeast(0, 2)).toBe(1);
    expect(poissonTailAtLeast(1, 2)).toBeCloseTo(1 - Math.exp(-2), 10);
    expect(poissonTailAtLeast(5, 2)).toBeLessThan(poissonTailAtLeast(2, 2));
  });
});

describe('taux d’erreur anormal', () => {
  const baseline = { errors: 5, total: 10_000 }; // 0,05 %

  it('tolère une fausse alerte par semaine, pas plus', () => {
    expect(FALSE_ALARM_PROBABILITY).toBeCloseTo(1 / 2016);
  });

  it('une erreur isolée dans un trafic normal n’alerte pas', () => {
    expect(errorRateVerdict({ errors: 1, total: 50 }, baseline).abnormal).toBe(false);
  });

  it('un seul volume d’erreurs alerte ou non selon le trafic, pas selon un nombre fixe', () => {
    // 4 erreurs sur 10 webhooks : très au-dessus du taux habituel.
    expect(errorRateVerdict({ errors: 4, total: 10 }, baseline).abnormal).toBe(true);
    // 4 erreurs sur 50 000 webhooks : c'est le bruit habituel de 0,05 %.
    expect(errorRateVerdict({ errors: 4, total: 50_000 }, baseline).abnormal).toBe(false);
  });

  it('sans historique fiable, alerte seulement si la majorité échoue', () => {
    const none = { errors: 0, total: MIN_BASELINE_EVENTS - 1 };
    expect(errorRateVerdict({ errors: 2, total: 3 }, none).abnormal).toBe(true);
    expect(errorRateVerdict({ errors: 1, total: 3 }, none).abnormal).toBe(false);
    expect(errorRateVerdict({ errors: 1, total: 1 }, none).abnormal).toBe(false);
  });

  it('aucune erreur ou aucun événement → jamais anormal', () => {
    expect(errorRateVerdict({ errors: 0, total: 100 }, baseline).abnormal).toBe(false);
    expect(errorRateVerdict({ errors: 0, total: 0 }, baseline).abnormal).toBe(false);
  });
});

describe('dépense et réserve en jours', () => {
  const DAY = 86_400_000;

  it('compteur cumulatif : dépense = hausse ÷ durée', () => {
    expect(
      dailySpend(
        [
          { at: 0, value: 100 },
          { at: 2 * DAY, value: 110 },
        ],
        'cumulative',
      ),
    ).toBeCloseTo(5);
  });

  it('solde : seules les baisses comptent, une recharge n’est pas une dépense négative', () => {
    expect(
      dailySpend(
        [
          { at: 0, value: 100 },
          { at: DAY, value: 90 }, // −10
          { at: 2 * DAY, value: 190 }, // recharge
          { at: 3 * DAY, value: 180 }, // −10
        ],
        'balance',
      ),
    ).toBeCloseTo(20 / 3);
  });

  it('moins d’une journée d’historique → dépense inconnue', () => {
    expect(
      dailySpend(
        [
          { at: 0, value: 1 },
          { at: DAY / 2, value: 5 },
        ],
        'cumulative',
      ),
    ).toBeNull();
    expect(dailySpend([{ at: 0, value: 1 }], 'balance')).toBeNull();
  });

  it('jours de réserve et niveau d’alerte', () => {
    expect(runwayDays(10, 2)).toBe(5);
    expect(runwayDays(10, 0)).toBe(Infinity);
    expect(runwayDays(10, null)).toBeNull();
    expect(runwayLevel(10, 5)).toBe('ok');
    expect(runwayLevel(10, 2.9)).toBe('warning');
    expect(runwayLevel(10, 0.9)).toBe('critical');
    expect(runwayLevel(0, null)).toBe('critical');
    expect(runwayLevel(3, null)).toBe('ok');
  });
});
