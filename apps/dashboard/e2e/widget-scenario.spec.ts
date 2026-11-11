import { test, expect } from '@playwright/test';
import {
  CHANGED_PARTY_SIZE,
  DEFAULT_PARTY_SIZE,
  FIRST_PARTY_SIZE,
  futureSlots,
  noOpenDayError,
  noScenarioError,
  pickFirstOpenDay,
  pickScenario,
  restaurantNowAt,
  timeLabel,
  type DayAvailability,
} from './support/widget-scenario';

/**
 * Le choix de la date de réservation ne dépend ni du jour ni de l'heure : il suit les disponibilités
 * de l'API et l'heure du restaurant. Ces cas rejouent ce que l'API de Chez Sokar renvoie : fermé
 * dimanche et lundi, créneaux de 12:00 à 21:30 les autres jours, créneaux passés du jour inclus.
 */

const SERVICE = Array.from({ length: 20 }, (_, index) => {
  const minutes = 12 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
});
const NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Sept jours d'octobre 2026 à partir de `day` (le 11 est un dimanche), comme le renvoie l'API. */
function week(day: number): DayAvailability[] {
  return Array.from({ length: 7 }, (_, offset): DayAvailability => {
    const weekday = (new Date(2026, 9, day + offset).getDay() + 7) % 7;
    const open = weekday >= 2 && weekday <= 6;
    const slots = open ? SERVICE : [];
    return {
      param: `2026-10-${String(day + offset).padStart(2, '0')}`,
      label: `${NAMES[weekday]} ${day + offset} octobre`,
      slotsByParty: {
        [DEFAULT_PARTY_SIZE]: slots,
        [FIRST_PARTY_SIZE]: slots,
        [CHANGED_PARTY_SIZE]: slots,
      },
    };
  });
}

/** Heure de Paris en octobre 2026 (UTC+2) : `paris('2026-10-13', '21:10')`. */
const paris = (date: string, time: string) => restaurantNowAt(new Date(`${date}T${time}:00+02:00`));

test.describe('choix de la date de réservation du widget', () => {
  test('un lundi (fermé) : saute au mardi, puis au mercredi', () => {
    const scenario = pickScenario(week(12), paris('2026-10-12', '17:08'));
    expect(scenario).toEqual({
      firstDate: '2026-10-13',
      firstTime: '21:30',
      secondDate: '2026-10-14',
      secondLabel: 'mercredi 14 octobre',
      secondTime: '21:30',
    });
  });

  test('un dimanche (fermé) : le mardi est le premier jour ouvert', () => {
    const scenario = pickScenario(week(11), paris('2026-10-11', '10:00'));
    expect(scenario).toMatchObject({ firstDate: '2026-10-13', secondDate: '2026-10-14' });
  });

  test('un mardi à 21:10 : le créneau de 21:30 du jour reste à venir', () => {
    const scenario = pickScenario(week(13), paris('2026-10-13', '21:10'));
    expect(scenario).toMatchObject({
      firstDate: '2026-10-13',
      firstTime: '21:30',
      secondDate: '2026-10-14',
    });
  });

  test('un mardi à 21:20 : 21:30 est à moins de 15 min, le premier jour devient mercredi', () => {
    const scenario = pickScenario(week(13), paris('2026-10-13', '21:20'));
    expect(scenario).toMatchObject({ firstDate: '2026-10-14', secondDate: '2026-10-15' });
  });

  test('un mardi à 22:00, après le dernier créneau : le premier jour devient mercredi', () => {
    const scenario = pickScenario(week(13), paris('2026-10-13', '22:00'));
    expect(scenario).toMatchObject({ firstDate: '2026-10-14', secondDate: '2026-10-15' });
  });

  test('un samedi à 22:00 : le service suivant est le mardi, puis le mercredi', () => {
    const scenario = pickScenario(week(17), paris('2026-10-17', '22:00'));
    expect(scenario).toMatchObject({ firstDate: '2026-10-20', secondDate: '2026-10-21' });
  });

  test('navigateur en UTC après minuit à Paris : la veille n’est jamais retenue', () => {
    // 22:30 UTC le samedi 17 = 00:30 à Paris le dimanche 18 : le widget liste encore le samedi.
    const now = restaurantNowAt(new Date('2026-10-17T22:30:00Z'));
    expect(now).toEqual({ date: '2026-10-18', minutes: 30 });
    const scenario = pickScenario(week(17), now);
    expect(scenario).toMatchObject({ firstDate: '2026-10-20', secondDate: '2026-10-21' });
  });

  test('au premier jour, le même créneau doit exister pour 4 et 5 personnes', () => {
    const days = week(13);
    days[0].slotsByParty[FIRST_PARTY_SIZE] = ['19:00'];
    days[0].slotsByParty[CHANGED_PARTY_SIZE] = ['20:00'];
    expect(pickScenario(days, paris('2026-10-13', '10:00'))?.firstDate).toBe('2026-10-14');
  });

  test('échoue quand un seul jour a des créneaux : pas de second jour', () => {
    const days = week(13);
    for (const day of days.slice(1)) {
      day.slotsByParty = {
        [DEFAULT_PARTY_SIZE]: [],
        [FIRST_PARTY_SIZE]: [],
        [CHANGED_PARTY_SIZE]: [],
      };
    }
    expect(pickScenario(days, paris('2026-10-13', '10:00'))).toBeNull();
  });

  test('échoue avec un message explicite quand aucun jour n’a de créneau', () => {
    const now = paris('2026-10-13', '10:00');
    const days = week(13).map((day) => ({
      ...day,
      slotsByParty: {
        [DEFAULT_PARTY_SIZE]: [],
        [FIRST_PARTY_SIZE]: [],
        [CHANGED_PARTY_SIZE]: [],
      },
    }));
    expect(pickScenario(days, now)).toBeNull();
    expect(pickFirstOpenDay(days, now)).toBeNull();
    const message = noScenarioError('chez-suppernote-demo', days, now).message;
    expect(message).toContain('Aucun scénario de réservation possible pour chez-suppernote-demo');
    expect(message).toContain('7 prochains jours');
    expect(message).toContain('Heure du restaurant : 2026-10-13 10:00');
    expect(message).toContain(
      'mardi 13 octobre (2026-10-13) → 2 pers. : 0, 4 pers. : 0, 5 pers. : 0',
    );
    expect(noOpenDayError('chez-suppernote-demo', days, now).message).toContain(
      'Aucun jour ouvert',
    );
  });

  test('chargement du widget : premier jour ouvert pour 2 personnes, à l’heure de Paris', () => {
    expect(pickFirstOpenDay(week(12), paris('2026-10-12', '17:08'))).toEqual({
      label: 'mardi 13 octobre',
      time: '21:30',
    });
    expect(pickFirstOpenDay(week(13), paris('2026-10-13', '22:00'))?.label).toBe(
      'mercredi 14 octobre',
    );
  });

  test('l’heure du restaurant suit l’heure d’été et d’hiver', () => {
    expect(restaurantNowAt(new Date('2026-10-13T19:10:00Z'))).toEqual({
      date: '2026-10-13',
      minutes: 21 * 60 + 10,
    });
    expect(restaurantNowAt(new Date('2026-12-01T20:00:00Z'))).toEqual({
      date: '2026-12-01',
      minutes: 21 * 60,
    });
  });

  test('futureSlots : jour passé vide, aujourd’hui avec 15 min de marge, demain entier', () => {
    const now = paris('2026-10-13', '13:00');
    const day = (param: string) => ({ param, label: param });
    expect(futureSlots(['12:00', '19:00'], day('2026-10-12'), now)).toEqual([]);
    expect(futureSlots(['13:00', '13:15', '13:30', '19:00'], day('2026-10-13'), now)).toEqual([
      '13:30',
      '19:00',
    ]);
    expect(futureSlots(['12:00', '19:00'], day('2026-10-14'), now)).toEqual(['12:00', '19:00']);
  });

  test('le nom d’un créneau suit le widget : 20:30 devient 20h30', () => {
    expect(timeLabel('20:30')).toBe('20h30');
  });
});
