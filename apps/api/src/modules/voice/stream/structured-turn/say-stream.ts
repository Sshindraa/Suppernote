/**
 * Extrait au fil du streaming la valeur de la clé `say` d'un objet JSON en cours
 * de génération. Le schéma place `say` après les champs lus par les gardes : dès que sa chaîne s'ouvre,
 * chaque caractère décodé peut partir vers la synthèse vocale.
 */
export class SayStreamExtractor {
  private buffer = '';
  private valueStart = -1;
  private cursor = 0;
  private done = false;
  private pendingEscape = '';

  /** Ajoute un fragment JSON et renvoie le texte de `say` nouvellement décodé. */
  push(fragment: string): string {
    this.buffer += fragment;
    if (this.done) return '';
    if (this.valueStart < 0) {
      const match = /"say"\s*:\s*"/.exec(this.buffer);
      if (!match) return '';
      this.valueStart = match.index + match[0].length;
      this.cursor = this.valueStart;
    }
    let decoded = '';
    while (this.cursor < this.buffer.length) {
      const char = this.buffer[this.cursor];
      if (this.pendingEscape) {
        this.pendingEscape += char;
        const escape = this.pendingEscape;
        if (escape.startsWith('\\u')) {
          if (escape.length < 6) {
            this.cursor++;
            continue;
          }
          decoded += String.fromCharCode(Number.parseInt(escape.slice(2), 16));
        } else {
          decoded += ESCAPES[escape[1]] ?? escape[1];
        }
        this.pendingEscape = '';
        this.cursor++;
        continue;
      }
      if (char === '\\') {
        this.pendingEscape = char;
        this.cursor++;
        continue;
      }
      if (char === '"') {
        this.done = true;
        this.cursor++;
        break;
      }
      decoded += char;
      this.cursor++;
    }
    return decoded;
  }

  /** JSON reçu jusqu'ici. */
  get raw(): string {
    return this.buffer;
  }
}

const ESCAPES: Record<string, string> = {
  n: ' ',
  r: ' ',
  t: ' ',
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '',
  f: '',
};

/** Début de première phrase sûr à dire seul : au moins 6 caractères, aucun chiffre, aucune lettre épelée. */
const EARLY_MIN_LENGTH = 6;

function earlyFragmentEnd(pending: string): number {
  const boundary = /,(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(pending)) !== null) {
    const fragment = pending.slice(0, match.index + 1).trim();
    // Un nombre ou une lettre isolée (« A, S, S ») se lit en entier : le nettoyage TTS regroupe les numéros.
    if (/\d/.test(fragment) || /(^|\s)\p{L},/u.test(fragment)) return -1;
    if (fragment.length >= EARLY_MIN_LENGTH) return match.index + 1;
  }
  return -1;
}

/**
 * Découpe le texte parlé en phrases complètes pour la synthèse. Le reste non
 * terminé est gardé jusqu'au prochain fragment ou jusqu'à `flush`.
 *
 * `early` : tant qu'aucune phrase n'est sortie, le début de la première phrase part dès sa première virgule
 * (« Très bien, »), la suite sort ensuite comme une phrase. La voix démarre sans attendre la ponctuation finale.
 */
export class PhraseSplitter {
  private pending = '';
  private emitted = false;
  private lastEarly = false;

  /** Le dernier `push` a rendu des premiers mots, pas une phrase finie. */
  get early(): boolean {
    return this.lastEarly;
  }

  push(text: string, options: { early?: boolean } = {}): string[] {
    this.pending += text;
    const phrases: string[] = [];
    const boundary = /[.!?…](?=\s)/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.pending)) !== null) {
      const phrase = this.pending.slice(start, match.index + 1).trim();
      if (phrase) phrases.push(phrase);
      start = match.index + 1;
    }
    this.pending = this.pending.slice(start);
    this.lastEarly = false;
    if (!phrases.length && options.early && !this.emitted) {
      const end = earlyFragmentEnd(this.pending);
      if (end > 0) {
        phrases.push(this.pending.slice(0, end).trim());
        this.pending = this.pending.slice(end);
        this.lastEarly = true;
      }
    }
    if (phrases.length) this.emitted = true;
    return phrases;
  }

  flush(): string | null {
    const rest = this.pending.trim();
    this.pending = '';
    if (rest) this.emitted = true;
    return rest || null;
  }
}
