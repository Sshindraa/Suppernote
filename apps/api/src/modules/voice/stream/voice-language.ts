import type { CallSession } from './types';

/**
 * Codes de langue acceptés par Cartesia Sonic. Le fournisseur STT peut retourner un code
 * ISO court ou un code enrichi (par exemple `en-US`) ; le pipeline conserve
 * ici le code court attendu par le TTS.
 */
export const CARTESIA_LANGUAGE_CODES = [
  'en',
  'fr',
  'de',
  'es',
  'pt',
  'zh',
  'ja',
  'hi',
  'it',
  'ko',
  'nl',
  'pl',
  'ru',
  'sv',
  'tr',
  'tl',
  'bg',
  'ro',
  'ar',
  'cs',
  'el',
  'fi',
  'hr',
  'ms',
  'sk',
  'da',
  'ta',
  'uk',
  'hu',
  'no',
  'vi',
  'bn',
  'th',
  'he',
  'ka',
  'id',
  'te',
  'gu',
  'kn',
  'ml',
  'mr',
  'pa',
  'or',
  'ur',
] as const;

export type VoiceLanguageCode = (typeof CARTESIA_LANGUAGE_CODES)[number];

const LANGUAGE_ALIASES: Record<string, VoiceLanguageCode> = {
  en: 'en',
  eng: 'en',
  fr: 'fr',
  fra: 'fr',
  fre: 'fr',
  de: 'de',
  deu: 'de',
  ger: 'de',
  es: 'es',
  spa: 'es',
  pt: 'pt',
  por: 'pt',
  zh: 'zh',
  zho: 'zh',
  cmn: 'zh',
  ja: 'ja',
  jpn: 'ja',
  hi: 'hi',
  hin: 'hi',
  it: 'it',
  ita: 'it',
  ko: 'ko',
  kor: 'ko',
  nl: 'nl',
  nld: 'nl',
  dut: 'nl',
  pl: 'pl',
  pol: 'pl',
  ru: 'ru',
  rus: 'ru',
  sv: 'sv',
  swe: 'sv',
  tr: 'tr',
  tur: 'tr',
  tl: 'tl',
  fil: 'tl',
  bg: 'bg',
  bul: 'bg',
  ro: 'ro',
  ron: 'ro',
  rum: 'ro',
  ar: 'ar',
  ara: 'ar',
  cs: 'cs',
  ces: 'cs',
  cze: 'cs',
  el: 'el',
  ell: 'el',
  gre: 'el',
  fi: 'fi',
  fin: 'fi',
  hr: 'hr',
  hrv: 'hr',
  ms: 'ms',
  msa: 'ms',
  may: 'ms',
  sk: 'sk',
  slk: 'sk',
  slo: 'sk',
  da: 'da',
  dan: 'da',
  ta: 'ta',
  tam: 'ta',
  uk: 'uk',
  ukr: 'uk',
  hu: 'hu',
  hun: 'hu',
  no: 'no',
  nor: 'no',
  vi: 'vi',
  vie: 'vi',
  bn: 'bn',
  ben: 'bn',
  th: 'th',
  tha: 'th',
  he: 'he',
  heb: 'he',
  ka: 'ka',
  kat: 'ka',
  geo: 'ka',
  id: 'id',
  ind: 'id',
  te: 'te',
  tel: 'te',
  gu: 'gu',
  guj: 'gu',
  kn: 'kn',
  kan: 'kn',
  ml: 'ml',
  mal: 'ml',
  mr: 'mr',
  mar: 'mr',
  pa: 'pa',
  pan: 'pa',
  or: 'or',
  ori: 'or',
  ory: 'or',
  ur: 'ur',
  urd: 'ur',
};

/**
 * Cartesia Sonic 3.6 attend une `locale` pour optimiser l'accent et la
 * normalisation. Cette valeur est volontairement séparée du code de langue
 * utilisé par le LLM : le LLM raisonne en `en`, tandis que Cartesia reçoit
 * `en-US` (ou une autre région explicitement détectée).
 */
export const CARTESIA_DEFAULT_LOCALE_BY_LANGUAGE: Record<VoiceLanguageCode, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  pt: 'pt-PT',
  zh: 'zh-CN',
  ja: 'ja-JP',
  hi: 'hi-IN',
  it: 'it-IT',
  ko: 'ko-KR',
  nl: 'nl-NL',
  pl: 'pl-PL',
  ru: 'ru-RU',
  sv: 'sv-SE',
  tr: 'tr-TR',
  tl: 'tl-PH',
  bg: 'bg-BG',
  ro: 'ro-RO',
  ar: 'ar-AE',
  cs: 'cs-CZ',
  el: 'el-GR',
  fi: 'fi-FI',
  hr: 'hr-HR',
  ms: 'ms-MY',
  sk: 'sk-SK',
  da: 'da-DK',
  ta: 'ta-IN',
  uk: 'uk-UA',
  hu: 'hu-HU',
  no: 'no-NO',
  vi: 'vi-VN',
  bn: 'bn-IN',
  th: 'th-TH',
  he: 'he-IL',
  ka: 'ka-GE',
  id: 'id-ID',
  te: 'te-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  pa: 'pa-IN',
  or: 'or-IN',
  ur: 'ur-IN',
};

export type VoiceLocaleCode = string;

/** Normalise un code de langue BCP-47 en code Cartesia, ou null si inconnu. */
export function normalizeVoiceLanguage(code: string | null | undefined): VoiceLanguageCode | null {
  if (!code) return null;
  const normalized = code.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return null;
  const [base] = normalized.split('-');
  return LANGUAGE_ALIASES[normalized] ?? LANGUAGE_ALIASES[base] ?? null;
}

/**
 * Normalise un code BCP-47 vers une locale Cartesia. Une région fournie par
 * le fournisseur STT est conservée (`en-GB`, `fr-CA`, …) ; sans région, nous utilisons la
 * région par défaut de Sonic 3.6 pour la langue détectée.
 */
export function normalizeVoiceLocale(code: string | null | undefined): VoiceLocaleCode | null {
  if (!code) return null;
  const normalized = code.trim().replace(/_/g, '-');
  if (!normalized) return null;
  const [, rawRegion] = normalized.split('-');
  const language = normalizeVoiceLanguage(normalized);
  if (!language) return null;
  if (rawRegion && /^[a-z]{2}$/i.test(rawRegion)) {
    return `${language}-${rawRegion.toUpperCase()}`;
  }
  return CARTESIA_DEFAULT_LOCALE_BY_LANGUAGE[language];
}

/** Langue active d'un appel ; le français reste le comportement historique. */
export function effectiveVoiceLanguage(
  session: Pick<CallSession, 'voiceLanguageCode' | 'sttLanguageCode'>,
): VoiceLanguageCode {
  return session.voiceLanguageCode ?? normalizeVoiceLanguage(session.sttLanguageCode) ?? 'fr';
}

/** Locale Cartesia active pour un appel. */
export function effectiveVoiceLocale(
  session: Pick<CallSession, 'voiceLanguageCode' | 'sttLanguageCode'>,
): VoiceLocaleCode {
  return (
    normalizeVoiceLocale(session.sttLanguageCode) ??
    CARTESIA_DEFAULT_LOCALE_BY_LANGUAGE[effectiveVoiceLanguage(session)]
  );
}

/**
 * Vérifie qu'un segment final contient suffisamment de signal pour influencer
 * la langue du dialogue. La détection du fournisseur STT est très utile sur une phrase
 * complète, mais un fragment VAD, un écho ou une répétition peut recevoir une
 * langue arbitraire. Ces segments ne doivent jamais faire basculer le LLM et
 * Cartesia au milieu d'un appel.
 */
export function hasReliableLanguageEvidence(transcript: string): boolean {
  const normalized = transcript
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized || /(?:\.\.\.|…)\s*$/u.test(transcript.trim())) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 3) return false;

  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const highestCount = Math.max(...counts.values());
  // « waouh waouh waouh calme-toi » is a classic acoustic echo/noise shape;
  // do not use it as evidence that the caller switched language.
  if (highestCount >= 3 && highestCount / words.length >= 0.6) return false;
  return true;
}

export interface VoiceLanguageCandidate {
  code: VoiceLanguageCode;
  count: number;
}

export interface VoiceLanguageDecision {
  language: VoiceLanguageCode;
  candidate: VoiceLanguageCandidate | null;
  accepted: boolean;
  changed: boolean;
}

/**
 * Stabilise une détection de langue avant de la transmettre au LLM/TTS.
 *
 * Le premier tour fiable peut choisir la langue de l'appel. Une fois le
 * dialogue commencé, une nouvelle langue doit être détectée deux fois de
 * suite ; cela évite qu'un seul segment mal classé (« it » sur une phrase
 * française) change la voix Cartesia.
 */
export function resolveVoiceLanguage(
  current: VoiceLanguageCode,
  detected: VoiceLanguageCode,
  transcript: string,
  turnCount: number,
  candidate: VoiceLanguageCandidate | null | undefined,
  /** Langue demandée par l'appelant en toutes lettres : elle s'applique tout de suite. */
  explicit = false,
): VoiceLanguageDecision {
  if (detected === current) {
    return { language: current, candidate: null, accepted: true, changed: false };
  }
  if (explicit) return { language: detected, candidate: null, accepted: true, changed: true };

  const evidence = hasReliableLanguageEvidence(transcript);
  if (!evidence) {
    return { language: current, candidate: null, accepted: false, changed: false };
  }

  if (turnCount === 0) {
    return { language: detected, candidate: null, accepted: true, changed: true };
  }

  if (candidate?.code === detected) {
    return { language: detected, candidate: null, accepted: true, changed: true };
  }

  return {
    language: current,
    candidate: { code: detected, count: 1 },
    accepted: false,
    changed: false,
  };
}

const REQUESTABLE_LANGUAGES: Record<string, VoiceLanguageCode> = {
  english: 'en',
  anglais: 'en',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  spanish: 'es',
  espagnol: 'es',
  german: 'de',
  allemand: 'de',
  italian: 'it',
  italien: 'it',
  portuguese: 'pt',
  portugais: 'pt',
};

/**
 * Langue que l'appelant demande explicitement (« Can you speak English? », « vous parlez anglais ? »), ou null.
 * shortcut: six langues et deux formulations (verbe parler + nom de langue) ; élargir si un appel réel en montre d'autres.
 */
export function requestedVoiceLanguage(transcript: string): VoiceLanguageCode | null {
  const match =
    /\b(?:speak|talk|parl(?:e|ez|er|ons)|in)\s+(?:in\s+|en\s+|le\s+)?(english|anglais|french|fran[cç]ais|spanish|espagnol|german|allemand|italian|italien|portuguese|portugais)\b/i.exec(
      transcript.normalize('NFC'),
    );
  return match ? (REQUESTABLE_LANGUAGES[match[1].toLowerCase()] ?? null) : null;
}
