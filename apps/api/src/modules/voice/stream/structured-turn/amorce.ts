/**
 * Amorce : les premiers mots d'une réponse, repris de ce que l'appelant vient de dire, dits pendant que le reste de
 * la sortie s'écrit. Elle part avant le brouillon et l'action : elle ne doit donc rien affirmer. Le code ne garde
 * que ce qui ne peut contredire la suite (appel du 18/11 ; écoute à l'aveugle du 20/11 : l'amorce envoyée 300 ou
 * 700 ms avant le reste s'entend comme une seule phrase).
 */

const MAX_LENGTH = 40;
const MAX_WORDS = 5;

/** Ce qu'une amorce ne peut pas dire avant les garde-fous : une réponse, une promesse, un fait vérifié. */
const COMMITTING =
  /\b(oui|non|ok|réserv\w*|disponib\w*|libre|complet|confirm\w*|fermé\w*|ouvert\w*|transf\w*|gérant|message|place)\b/i;

/** Accusé de réception seul : un réflexe, pas une reprise de ce que l'appelant a dit. */
const BARE_ACK =
  /^(d'accord|très bien|parfait|super|entendu|bien sûr|avec plaisir|bien|bon|alors|hmm|euh)[.,…]*$/i;

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** L'amorce à dire telle quelle, ou `null` si elle ne passe pas les règles. */
export function speakableAmorce(raw: string | undefined): string | null {
  const text = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > MAX_LENGTH) return null;
  if (words(text).length > MAX_WORDS) return null;
  if (/[?!]/.test(text) || COMMITTING.test(text) || BARE_ACK.test(text)) return null;
  // Une lettre isolée (« H, O ») : épellation, relue par le code ailleurs. « à », « y » et « 14 h » restent permis.
  const spelled = text.split(/[\s,.…]+/).some((token, index, all) => {
    if (!/^\p{L}$/u.test(token) || /^[àay]$/i.test(token)) return false;
    return !(/^h$/i.test(token) && /\d$/.test(all[index - 1] ?? ''));
  });
  if (spelled) return null;
  // Ponctuation finale : la voix doit entendre une fin de groupe, pas une phrase coupée.
  return /[.,…]$/.test(text) ? text : `${text}.`;
}

/** Un mot qui porte du sens (« dimanche », « 16 »), pas un mot outil (« à », « le »). */
const isContentWord = (word: string) => word.length >= 3 || /\d/.test(word);

/**
 * Ce qui reste à dire de `say` une fois l'amorce prononcée : si `say` commence par des mots de l'amorce (« Dimanche
 * soir, » puis « Dimanche, le restaurant est fermé »), ce début commun est retiré, à condition qu'il contienne un mot
 * qui porte du sens. `null` tant que le début de `say` reçu est trop court pour trancher.
 */
export function sayAfterAmorce(
  amorce: string,
  sayStart: string,
  sayComplete: boolean,
): string | null {
  const expected = words(amorce);
  const got = words(sayStart);
  // Le dernier mot reçu peut être coupé : on attend d'avoir dépassé la longueur de l'amorce.
  if (!sayComplete && (got.length < expected.length || !/[\s.,…?!]$/.test(sayStart))) {
    if (got.length <= expected.length) return null;
  }
  let common = 0;
  while (common < expected.length && common < got.length && expected[common] === got[common])
    common++;
  if (!expected.slice(0, common).some(isContentWord)) return sayStart;
  let seen = 0;
  const pattern = /[\p{L}\p{N}']+/gu;
  let match: RegExpExecArray | null;
  let cut = 0;
  while ((match = pattern.exec(sayStart)) !== null) {
    seen++;
    if (seen === common) {
      cut = match.index + match[0].length;
      break;
    }
  }
  return sayStart.slice(cut).replace(/^[\s.,…]+/, '');
}
