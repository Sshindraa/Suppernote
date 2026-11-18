const WEEKDAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Heure locale (0 à 23) à l'instant donné, dans le fuseau du restaurant. */
export function localHour(now: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(now);
  return Number(hour);
}

/** Date locale AAAA-MM-JJ à l'instant donné, dans le fuseau du restaurant. */
export function localIsoDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(now);
}

/** Jour de la semaine en français d'une date AAAA-MM-JJ (calcul en UTC : indépendant du fuseau de la machine). */
export function weekdayFr(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return WEEKDAYS_FR[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * Entre minuit et 5 h (heure du restaurant), « demain » peut désigner encore le jour en cours : l'appelant qui dit
 * « demain » à 00 h 16 vise souvent la nuit qu'il vit. Le moteur doit alors nommer le jour avant de fixer la date.
 */
export function isEarlyMorning(now: Date, timezone: string): boolean {
  return localHour(now, timezone) < 5;
}

/** Les deux jours entre lesquels « demain » est ambigu avant 5 h : le jour en cours puis le suivant (« jeudi ou vendredi »). */
export function ambiguousDayPair(now: Date, timezone: string): string {
  const today = localIsoDate(now, timezone);
  const [year, month, day] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return `${weekdayFr(today)} ou ${weekdayFr(tomorrow)}`;
}
