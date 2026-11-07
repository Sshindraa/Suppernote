import { describe, expect, it, vi } from 'vitest';
import {
  greetingCacheKey,
  hasStyledGreeting,
  isValidGreeting,
  pickVariant,
  resolveStyledGreeting,
  toDraft,
  type GreetingStore,
} from '../stream/styled-greeting';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: GreetingStore = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
      return 'OK';
    }),
  };
  return { store, data };
}

const NAME = 'Little Italy';
const FORMAL = { profileType: 'GASTRONOMIQUE', fillerStyle: 'FORMAL' };
const NO_NAME = 'Bonsoir, ici Léa, l’assistante IA. Je vous écoute.';
const WITH_DIGIT = 'Little Italy, Léa, assistante IA, 20 couverts ce soir.';
const OK_SHORT = 'Little Italy, bonsoir, je suis Léa, l’assistante IA. Je vous écoute.';
const OK_LONG =
  'Little Italy vous souhaite la bienvenue, ici Léa, l’assistante IA de la maison. Je vous écoute.';
const NO_DISCLOSURE = 'Little Italy, bonsoir. Je vous écoute.';

describe('hasStyledGreeting', () => {
  it('le réglage par défaut garde l’accueil fixe', () => {
    expect(hasStyledGreeting({ profileType: 'BISTROT_BRASSERIE', fillerStyle: 'CASUAL' })).toBe(
      false,
    );
    expect(hasStyledGreeting(null)).toBe(false);
    expect(hasStyledGreeting(FORMAL)).toBe(true);
    expect(hasStyledGreeting({ fillerStyle: 'WARM' })).toBe(true);
  });
});

describe('isValidGreeting', () => {
  it('exige le nom, une phrase courte, sans chiffre ni point d’exclamation', () => {
    expect(isValidGreeting(OK_SHORT, NAME)).toBe(true);
    expect(isValidGreeting(NO_NAME, NAME)).toBe(false);
    expect(isValidGreeting(WITH_DIGIT, NAME)).toBe(false);
    expect(
      isValidGreeting('Little Italy, Léa, assistante IA, bonsoir ! Je vous écoute.', NAME),
    ).toBe(false);
    expect(isValidGreeting(`Little Italy ${'bonsoir '.repeat(30)}`, NAME)).toBe(false);
  });

  it('exige Léa et l’annonce IA (règlement européen sur l’IA)', () => {
    expect(isValidGreeting(NO_DISCLOSURE, NAME)).toBe(false);
    expect(isValidGreeting('Little Italy, je suis l’assistante IA. Je vous écoute.', NAME)).toBe(
      false,
    );
    expect(
      isValidGreeting('Little Italy, ici Léa, votre assistante virtuelle. Je vous écoute.', NAME),
    ).toBe(true);
  });

  it('ignore la casse et les accents du nom', () => {
    expect(
      isValidGreeting(
        'Bonsoir, ici LE CAFÉ de Paris, je suis LÉA, l’assistante IA. Je vous écoute.',
        'Le Café de Paris',
      ),
    ).toBe(true);
    expect(
      isValidGreeting(
        'Bonsoir, ici le cafe de paris, je suis lea, l’assistante ia. Je vous écoute.',
        'Le Café de Paris',
      ),
    ).toBe(true);
  });
});

describe('pickVariant', () => {
  it('prend la variante désignée quand elle est valide', () => {
    expect(pickVariant({ variants: [NO_NAME, OK_SHORT, OK_LONG], best: 3 }, NAME)).toBe(OK_LONG);
  });

  it('à défaut, prend la première autre variante valide', () => {
    expect(pickVariant({ variants: [NO_NAME, OK_SHORT, OK_LONG], best: 1 }, NAME)).toBe(OK_SHORT);
  });

  it('renvoie null quand aucune variante ne passe les contrôles', () => {
    expect(pickVariant({ variants: [NO_NAME, WITH_DIGIT], best: 1 }, NAME)).toBeNull();
  });

  it('ignore un numéro hors des variantes', () => {
    expect(pickVariant({ variants: [OK_SHORT], best: 9 }, NAME)).toBe(OK_SHORT);
  });
});

describe('toDraft', () => {
  it('lit la forme attendue et ignore le reste', () => {
    expect(toDraft({ variants: [` ${OK_SHORT} `, NO_NAME], best: 2 })).toEqual({
      variants: [OK_SHORT, NO_NAME],
      best: 2,
    });
    expect(toDraft({ variants: [OK_SHORT], best: 'deux' })).toEqual({
      variants: [OK_SHORT],
      best: 0,
    });
    expect(toDraft('texte libre')).toBeNull();
    expect(toDraft({ best: 1 })).toBeNull();
    expect(toDraft(null)).toBeNull();
  });
});

describe('resolveStyledGreeting', () => {
  it('ne compose rien pour le réglage par défaut : aucun appel au modèle', async () => {
    const llm = vi.fn();
    const { store } = memoryStore();
    const result = await resolveStyledGreeting(
      NAME,
      { profileType: 'BISTROT_BRASSERIE', fillerStyle: 'CASUAL' },
      { store, llm },
    );
    expect(result).toBeNull();
    expect(llm).not.toHaveBeenCalled();
  });

  it('compose une fois, garde en cache, puis rejoue sans rappeler le modèle', async () => {
    const llm = vi.fn().mockResolvedValue({ variants: [NO_NAME, OK_LONG, OK_SHORT], best: 2 });
    const { store, data } = memoryStore();
    const first = await resolveStyledGreeting(NAME, FORMAL, { store, llm });
    const second = await resolveStyledGreeting(NAME, FORMAL, { store, llm });
    expect(first).toBe(OK_LONG);
    expect(second).toBe(OK_LONG);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(data.get(greetingCacheKey(NAME, FORMAL))).toBe(OK_LONG);
  });

  it('prolonge la durée de vie du texte composé à chaque relecture', async () => {
    const llm = vi.fn().mockResolvedValue({ variants: [OK_LONG], best: 1 });
    const { store } = memoryStore();
    await resolveStyledGreeting(NAME, FORMAL, { store, llm });
    vi.mocked(store.set).mockClear();

    await resolveStyledGreeting(NAME, FORMAL, { store, llm });

    expect(store.set).toHaveBeenCalledWith(
      greetingCacheKey(NAME, FORMAL),
      OK_LONG,
      'EX',
      30 * 24 * 3600,
    );
  });

  it('transmet le délai demandé au modèle', async () => {
    const llm = vi.fn().mockResolvedValue({ variants: [OK_SHORT], best: 1 });
    await resolveStyledGreeting(NAME, FORMAL, {
      store: memoryStore().store,
      llm,
      attempts: 2,
      timeoutMs: 4_000,
    });
    expect(llm).toHaveBeenLastCalledWith(NAME, FORMAL, 4_000);
  });

  it('réessaie selon le nombre d’essais demandé', async () => {
    const llm = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ variants: [OK_SHORT], best: 1 });
    await expect(
      resolveStyledGreeting(NAME, FORMAL, { store: memoryStore().store, llm, attempts: 2 }),
    ).resolves.toBe(OK_SHORT);
    expect(llm).toHaveBeenCalledTimes(2);

    const single = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(
      resolveStyledGreeting('Chez Marcel', FORMAL, { store: memoryStore().store, llm: single }),
    ).resolves.toBeNull();
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('retombe sur l’accueil fixe (null) sans rien mettre en cache quand aucune variante ne passe', async () => {
    const { store, data } = memoryStore();
    await expect(
      resolveStyledGreeting(NAME, FORMAL, {
        store,
        llm: vi.fn().mockResolvedValue({ variants: [NO_NAME, WITH_DIGIT], best: 1 }),
      }),
    ).resolves.toBeNull();
    await expect(
      resolveStyledGreeting(NAME, FORMAL, { store, llm: vi.fn().mockResolvedValue(null) }),
    ).resolves.toBeNull();
    expect(data.size).toBe(0);
  });

  it('ignore une entrée de cache devenue invalide et recompose', async () => {
    const key = greetingCacheKey(NAME, FORMAL);
    const { store } = memoryStore({ [key]: 'Texte sans le nom du restaurant.' });
    const llm = vi.fn().mockResolvedValue({ variants: [OK_SHORT], best: 1 });
    await expect(resolveStyledGreeting(NAME, FORMAL, { store, llm })).resolves.toBe(OK_SHORT);
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

describe('greetingCacheKey', () => {
  it('change avec le nom et avec le réglage, et reste stable pour une même entrée', () => {
    expect(greetingCacheKey(NAME, FORMAL)).toBe(greetingCacheKey(NAME, FORMAL));
    expect(greetingCacheKey(NAME, FORMAL)).not.toBe(
      greetingCacheKey(NAME, { profileType: 'GASTRONOMIQUE', fillerStyle: 'WARM' }),
    );
    expect(greetingCacheKey(NAME, FORMAL)).not.toBe(greetingCacheKey('Chez Marcel', FORMAL));
    expect(greetingCacheKey(NAME, FORMAL).startsWith('greeting:v4:')).toBe(true);
  });
});
