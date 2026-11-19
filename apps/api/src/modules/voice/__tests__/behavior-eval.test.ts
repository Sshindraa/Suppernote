import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRequests } from '../behavior-eval/build';
import { buildSystemPrompt } from '../prompts';
import { buildStructuredTurnMessages } from '../stream/structured-turn/prompt';
import { createStructuredTurnState } from '../stream/structured-turn/fact-guards';
import { casesForSuite, generatePerturbations, PERTURB_SAMPLES } from '../behavior-eval/perturb';
import {
  formatReport,
  MIN_VALID_RATE,
  scoreAll,
  scoreCase,
  splitOf,
  summarize,
} from '../behavior-eval/score';
import type { BehaviorCase, BehaviorCasesFile } from '../behavior-eval/types';
import { systemOf } from './helpers/system-of';

const baseCase = (checks: BehaviorCase['checks']): BehaviorCase => ({
  id: 'cas',
  behavior: 'test',
  family: 'attente',
  measures: 'model',
  origin: 'control',
  source: 'test',
  history: [],
  transcript: 'bonjour',
  checks,
});

const say = (text: string, extra: Record<string, unknown> = {}) => ({ say: text, ...extra });

describe('scoreCase : garde-fou de l’épellation après la relecture', () => {
  it('passe le nom relu au garde-fou, comme le moteur : brut faux, rattrapé après garde-fou', () => {
    const testCase: BehaviorCase = {
      ...baseCase([{ kind: 'draft', field: 'customerName', equals: 'HOUET', minRate: 0.85 }]),
      transcript: 'e t',
      draft: { customerName: 'HOUT' },
      awaiting: 'customerNameConfirmation',
    };
    const samples = [{ say: 'ok', draft: { customerName: 'HOUTET' } }];
    const [check] = scoreCase(testCase, samples).checks;
    expect(check.rate).toBe(0);
    expect(check.guardedRate).toBe(1);
  });
});

describe('scoreCase', () => {
  it('mesure la part des tirages qui tiennent un champ, en ignorant les réponses invalides', () => {
    const result = scoreCase(
      baseCase([{ kind: 'field', path: 'turnComplete', equals: false, minRate: 0.7 }]),
      [
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        say('ok', { turnComplete: true }),
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        say('', { turnComplete: false }),
        null,
      ],
    );
    expect(result.valid).toBe(9);
    expect(result.checks[0].rate).toBeCloseTo(8 / 9);
    expect(result.passed).toBe(true);
  });

  it('échoue quand trop de réponses sont invalides, même si le reste est parfait', () => {
    const samples = [say('', { turnComplete: false }), null, null];
    expect(1 / 3).toBeLessThan(MIN_VALID_RATE);
    const result = scoreCase(
      baseCase([{ kind: 'field', path: 'turnComplete', equals: false, minRate: 0.5 }]),
      samples,
    );
    expect(result.passed).toBe(false);
  });

  it('échoue sans aucune réponse valide (quota épuisé, réseau coupé)', () => {
    const result = scoreCase(baseCase([{ kind: 'say', pattern: 'x', expect: false, minRate: 0 }]), [
      null,
      null,
    ]);
    expect(result.passed).toBe(false);
  });

  it('interdit un motif dans la phrase, insensible à la casse', () => {
    const result = scoreCase(
      baseCase([{ kind: 'say', pattern: 'soirée', expect: false, minRate: 0.5 }]),
      [say('Bonne SOIRÉE'), say('Bonne fin d’après-midi'), say('À demain')],
    );
    expect(result.checks[0].rate).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(true);
  });

  it('compare un champ du brouillon sans tenir compte de la casse, et les nombres exactement', () => {
    const result = scoreCase(
      baseCase([
        { kind: 'draft', field: 'customerName', equals: 'HOUET', minRate: 1 },
        { kind: 'draft', field: 'partySize', equals: 6, minRate: 1 },
      ]),
      [say('', { draft: { customerName: 'Houet', partySize: 6 } })],
    );
    expect(result.passed).toBe(true);
  });

  it('détecte la recopie de la dernière question, ponctuation et casse ignorées', () => {
    const result = scoreCase(
      baseCase([
        { kind: 'noRepeatOf', text: 'Vers quelle heure vous aimeriez venir', minRate: 0.6 },
      ]),
      [
        say('Oui, il y a une terrasse. Vers quelle heure vous aimeriez venir ?'),
        say('Oui, une terrasse. Et pour quelle heure ?'),
        say('Une terrasse, oui. Vous venez à quelle heure ?'),
      ],
    );
    expect(result.checks[0].rate).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(true);
  });

  it('borne la longueur moyenne des phrases', () => {
    const short = scoreCase(baseCase([{ kind: 'sayWords', maxMean: 5 }]), [
      say('un deux trois'),
      say('quatre cinq'),
    ]);
    const long = scoreCase(baseCase([{ kind: 'sayWords', maxMean: 2 }]), [
      say('un deux trois'),
      say('quatre cinq'),
    ]);
    expect(short.passed).toBe(true);
    expect(long.passed).toBe(false);
  });
});

describe('nouveaux contrôles structurels', () => {
  const withDraft = (draft: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    say: '',
    draft,
    ...extra,
  });
  const empty = { date: '', time: '', partySize: 0, customerName: '' };

  it('draftUnchanged : vrai seulement si les champs listés gardent leur valeur entrante', () => {
    const testCase = {
      ...baseCase([{ kind: 'draftUnchanged', fields: ['time', 'partySize'], minRate: 1 }]),
      draft: { date: '2026-09-30', time: '14:00' },
    };
    const kept = scoreCase(testCase, [withDraft({ ...empty, date: '2026-10-01', time: '14:00' })]);
    const changed = scoreCase(testCase, [withDraft({ ...empty, time: '20:00' })]);
    const noDraft = scoreCase(testCase, [{ say: '' }]);
    expect(kept.checks[0].rate).toBe(1);
    expect(changed.checks[0].rate).toBe(0);
    expect(noDraft.checks[0].rate).toBe(0);
  });

  it('fieldIn : le champ appartient à la liste', () => {
    const result = scoreCase(
      baseCase([{ kind: 'fieldIn', path: 'confidence', values: ['low'], minRate: 0.5 }]),
      [{ confidence: 'low' }, { confidence: 'high' }],
    );
    expect(result.checks[0].rate).toBe(0.5);
    expect(result.passed).toBe(true);
  });

  it('anyOf se mesure tirage par tirage, pas en moyenne des sous-contrôles', () => {
    const testCase = baseCase([
      {
        kind: 'anyOf',
        of: [
          { kind: 'draftUnchanged', fields: ['time'] },
          { kind: 'fieldIn', path: 'interpretation', values: ['unclear'] },
          { kind: 'fieldIn', path: 'confidence', values: ['low'] },
        ],
        minRate: 0,
      },
    ]);
    const result = scoreCase(testCase, [
      withDraft(empty), // heure inchangée
      withDraft({ ...empty, time: '20:00' }, { interpretation: 'unclear' }), // changée mais dit ne pas comprendre
      withDraft({ ...empty, time: '20:00' }, { interpretation: 'answer', confidence: 'low' }),
      withDraft({ ...empty, time: '20:00' }, { interpretation: 'answer', confidence: 'high' }), // sûr de lui et faux
    ]);
    expect(result.checks[0].rate).toBe(0.75);
  });
});

describe('split calibration / contrôle', () => {
  it("est stable et dérivé de l'identifiant, sauf valeur explicite", () => {
    expect(splitOf({ id: 'cas-a' })).toBe(splitOf({ id: 'cas-a' }));
    expect(splitOf({ id: 'cas-a', split: 'holdout' })).toBe('holdout');
    const splits = Array.from({ length: 300 }, (_, index) => splitOf({ id: `cas-${index}` }));
    const holdout = splits.filter((split) => split === 'holdout').length;
    expect(holdout).toBeGreaterThan(70);
    expect(holdout).toBeLessThan(130);
  });

  it('une variante suit le découpage de son cas de départ', () => {
    const base = splitOf({ id: 'extrait-taille-groupe' });
    expect(
      splitOf({
        id: 'extrait-taille-groupe~noise~partySize',
        perturbation: { kind: 'noise', base: 'extrait-taille-groupe', field: 'partySize' },
      }),
    ).toBe(base);
  });
});

const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, '../../../../scripts/fixtures/voice-behavior/cases.json'),
    'utf8',
  ),
) as BehaviorCasesFile;

describe('variantes dégradées générées', () => {
  const variants = generatePerturbations(fixture);
  const byKind = (kind: string) => variants.filter((v) => v.perturbation?.kind === kind);

  it('est déterministe : deux générations donnent exactement les mêmes variantes', () => {
    expect(generatePerturbations(fixture)).toEqual(variants);
  });

  it('change avec la graine', () => {
    expect(generatePerturbations(fixture, 1)).not.toEqual(variants);
  });

  it('génère les trois familles, sous le plafond de requêtes du rejeu', () => {
    expect(byKind('ablation').length).toBeGreaterThan(0);
    expect(byKind('substitution').length).toBeGreaterThan(0);
    expect(byKind('noise').length).toBeGreaterThan(0);
    const requests = variants.length * PERTURB_SAMPLES;
    expect(requests).toBeLessThanOrEqual(150);
  });

  it('identifiants uniques, distincts de ceux des cas, chaque variante a un contrôle', () => {
    const ids = [...fixture.cases, ...variants].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of variants) expect(v.checks).toHaveLength(1);
  });

  it("l'ablation retire exactement la sous-chaîne annotée, jamais plus", () => {
    for (const v of byKind('ablation')) {
      const base = fixture.cases.find((c) => c.id === v.perturbation?.base)!;
      const span = base.valueSpans![v.perturbation!.field]!;
      expect(v.transcript).not.toContain(span.text);
      expect(v.transcript.length).toBeGreaterThan(0);
      expect(base.transcript.replace(span.text, ' ').replace(/\s+/g, ' ').trim()).toBe(
        v.transcript,
      );
    }
  });

  it("la substitution attend la valeur du donneur, différente de celle d'origine", () => {
    for (const v of byKind('substitution')) {
      const base = fixture.cases.find((c) => c.id === v.perturbation?.base)!;
      const span = base.valueSpans![v.perturbation!.field]!;
      const check = v.checks[0];
      expect(check.kind).toBe('draft');
      if (check.kind === 'draft') {
        expect(String(check.equals).toLowerCase()).not.toBe(String(span.value).toLowerCase());
        expect(v.transcript).not.toBe(base.transcript);
      }
    }
  });

  it("le bruit garde la sous-chaîne annotée intacte et n'insère aucun mot qui porte une valeur", () => {
    for (const v of byKind('noise')) {
      const base = fixture.cases.find((c) => c.id === v.perturbation?.base)!;
      const span = base.valueSpans![v.perturbation!.field]!;
      expect(v.transcript).toContain(span.text);
      const inserted = v.transcript
        .replace(span.text, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((word) => !base.transcript.split(/\s+/).includes(word));
      for (const word of inserted) expect(word).not.toMatch(/\d/);
    }
  });

  it('refuse une annotation dont la sous-chaîne est absente de la phrase', () => {
    const broken: BehaviorCasesFile = {
      ...fixture,
      cases: [{ ...baseCase([]), valueSpans: { time: { text: 'introuvable', value: '20:00' } } }],
    };
    expect(() => generatePerturbations(broken)).toThrow(/introuvable/);
  });

  it('les variantes sont informatives : elles ne font jamais échouer le jeu', () => {
    const results = scoreAll(variants, {
      model: 'test',
      responses: Object.fromEntries(
        variants.map((v) => [
          v.id,
          Array.from({ length: PERTURB_SAMPLES }, () => ({ say: '', draft: {} })),
        ]),
      ),
    });
    expect(results.every((r) => r.informational)).toBe(true);
    expect(formatReport(results)).toContain('informatif');
  });

  it('casesForSuite : default, perturb et all', () => {
    expect(casesForSuite(fixture, 'default')).toEqual(fixture.cases);
    expect(casesForSuite(fixture, 'perturb')).toEqual(variants);
    expect(casesForSuite(fixture, 'all')).toHaveLength(fixture.cases.length + variants.length);
  });
});

describe('indicateurs agrégés', () => {
  const variants = generatePerturbations(fixture);
  const respond = (draftFor: (variantKind: string) => Record<string, unknown>) => ({
    model: 'test',
    responses: Object.fromEntries(
      variants.map((v) => [
        v.id,
        Array.from({ length: PERTURB_SAMPLES }, () => ({
          say: '',
          ...draftFor(v.perturbation!.kind),
        })),
      ]),
    ),
  });

  it('un modèle qui invente la valeur retirée, ignore la phrase et perd la valeur au bruit', () => {
    // Sortie : brouillon vide + sûr de lui. Ablation : inchangé si le brouillon entrant est vide.
    const never = summarize(
      scoreAll(
        variants,
        respond(() => ({ draft: { date: '', time: '', partySize: 0, customerName: '' } })),
      ),
    );
    expect(never.calibration.fidelityRate).toBe(0);
    expect(never.calibration.noiseRobustness).toBe(0);
    const total = never.calibration.variants.substitution + never.holdout.variants.substitution;
    expect(total).toBe(variants.filter((v) => v.perturbation?.kind === 'substitution').length);
  });

  it('ne compte pas une variante dont trop de réponses sont invalides', () => {
    const responses = respond(() => ({ draft: {} }));
    const victim = variants.find((v) => v.perturbation?.kind === 'ablation')!;
    responses.responses[victim.id] = Array.from({ length: PERTURB_SAMPLES }, () => null) as never;
    const before = summarize(
      scoreAll(
        variants,
        respond(() => ({ draft: {} })),
      ),
    );
    const after = summarize(scoreAll(variants, responses));
    const split = splitOf(victim);
    expect(after[split].variants.ablation).toBe(before[split].variants.ablation - 1);
  });
});

describe('sortie brute et après garde-fous', () => {
  const spelled: BehaviorCase = {
    ...baseCase([{ kind: 'draft', field: 'customerName', equals: 'HOUET', minRate: 1 }]),
    transcript: 'h o u e t dimanche',
    awaiting: 'customerName',
  };
  const glued = { say: '', draft: { customerName: 'HOUET DIMANCHE' } };

  it("note le brouillon brut : le garde-fou de l'épellation ne rattrape pas le modèle", () => {
    const result = scoreCase(spelled, [glued, glued]);
    expect(result.checks[0].rate).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('rapporte à côté le chiffre après garde-fous, seulement quand il change quelque chose', () => {
    const result = scoreCase(spelled, [glued, glued]);
    expect(result.checks[0].guardedRate).toBe(1);
    const clean = scoreCase(spelled, [{ say: '', draft: { customerName: 'HOUET' } }]);
    expect(clean.checks[0].rate).toBe(1);
    expect(clean.checks[0].guardedRate).toBeUndefined();
    expect(formatReport([result])).toContain('après garde-fous : 100 %');
  });

  it('les indicateurs agrégés existent en brut et après garde-fous', () => {
    const variants = generatePerturbations(fixture);
    const responses = {
      model: 'test',
      responses: Object.fromEntries(
        variants.map((v) => [
          v.id,
          Array.from({ length: PERTURB_SAMPLES }, () => ({ say: '', draft: {} })),
        ]),
      ),
    };
    const summary = summarize(scoreAll(variants, responses));
    for (const split of ['calibration', 'holdout'] as const) {
      expect(summary[split].guarded).toHaveProperty('noiseRobustness');
      expect(summary[split].guarded).toHaveProperty('fidelityRate');
    }
  });
});

describe('indépendance du banc', () => {
  const benchFile = JSON.parse(
    readFileSync(
      path.join(__dirname, '../../../../scripts/fixtures/voice-behavior/cases.json'),
      'utf8',
    ),
  ) as BehaviorCasesFile;
  const hours = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
      day,
      { open: '12:00', close: '22:00' },
    ]),
  );
  const normalize = (text: string) =>
    text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
  // Le prompt réel reçu par le modèle, consignes de compréhension comprises.
  const prompts = [true, false].map(() => {
    const base = buildSystemPrompt({ name: 'Chez Test', openingHours: hours });
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: base,
        history: [],
        transcript: 'x',
        state: createStructuredTurnState(),
        openingHours: hours,
        today: '2026-09-30',
        understanding: true,
      }),
    );
    return normalize(String(system.content));
  });
  const NUMBER_WORDS: Record<number, string> = {
    1: 'un',
    2: 'deux',
    3: 'trois',
    4: 'quatre',
    5: 'cinq',
    6: 'six',
    7: 'sept',
    8: 'huit',
    9: 'neuf',
    10: 'dix',
  };
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contains = (prompt: string, needle: string) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escape(normalize(needle))}([^\\p{L}\\p{N}]|$)`, 'u').test(
      prompt,
    );

  it('aucune phrase, aucun extrait annoté ni aucun nom attendu du banc ne figure dans le prompt', () => {
    // Un exemple du prompt qui est aussi un cas du banc fait mesurer la mémorisation, pas la compréhension.
    const leaks: string[] = [];
    for (const testCase of benchFile.cases) {
      const needles = [
        ...(testCase.transcript.trim().split(/\s+/).length >= 2 ? [testCase.transcript] : []),
        ...Object.values(testCase.valueSpans ?? {}).flatMap((span) => [
          ...(span.text.length >= 3 ? [span.text] : []),
          ...(typeof span.value === 'string' && /^[A-ZÀ-Ý]{4,}$/u.test(span.value)
            ? [span.value]
            : []),
          // Un nombre du banc dit en toutes lettres (« six » pour 6) : même fuite qu'un extrait.
          ...(typeof span.value === 'number' && NUMBER_WORDS[span.value]
            ? [NUMBER_WORDS[span.value]]
            : []),
        ]),
      ];
      for (const needle of needles) {
        if (prompts.some((prompt) => contains(prompt, needle))) {
          leaks.push(`${testCase.id} : « ${needle} »`);
        }
      }
    }
    expect([...new Set(leaks)]).toEqual([]);
  });
});

describe('cas réels du jeu de comportements', () => {
  const file = JSON.parse(
    readFileSync(
      path.join(__dirname, '../../../../scripts/fixtures/voice-behavior/cases.json'),
      'utf8',
    ),
  ) as BehaviorCasesFile;

  it('la vérification de compréhension change la requête du banc, sans toucher aux autres', () => {
    const base = buildRequests(file);
    const checked = buildRequests(file, { understanding: true });
    expect(checked).toHaveLength(base.length);
    const schema = (request: (typeof base)[number]) =>
      request.format.json_schema.schema as { properties: Record<string, unknown> };
    for (const [index, request] of checked.entries()) {
      expect(schema(request).properties).toHaveProperty('understanding');
      expect(schema(base[index]).properties).not.toHaveProperty('understanding');
      expect(systemOf(request.messages).content).toContain('COMPRÉHENSION VÉRIFIÉE');
    }
  });

  it('chaque cas se compose en une requête complète avec le prompt courant', () => {
    const requests = buildRequests(file);
    expect(requests).toHaveLength(file.cases.length);
    for (const request of requests) {
      expect(request.messages[0].role).toBe('system');
      expect(request.messages.at(-1)?.role).toBe('user');
      expect(request.samples).toBeGreaterThan(0);
    }
  });

  it('le cas bf3893ae est informatif : la vérité terrain attend une écoute humaine', () => {
    const real = file.cases.find((c) => c.id === 'appel-bf3893ae-enonce-incoherent');
    expect(real?.truthStatus).toBe('unverified');
    const result = scoreCase(real!, [{ say: '', draft: { time: '20:00' }, confidence: 'high' }]);
    expect(result.informational).toBe(true);
  });

  it('les identifiants sont uniques et chaque cas a au moins un contrôle', () => {
    const ids = file.cases.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of file.cases) expect(testCase.checks.length).toBeGreaterThan(0);
  });

  it("un cas après action n'autorise que parler ou terminer l'appel", () => {
    const request = buildRequests(file).find((r) => r.id === 'au-revoir-selon-heure');
    const schema = request?.format.json_schema.schema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual(['none', 'end_call']);
  });

  it('le fait du moment de la journée est bien transmis quand le cas le demande', () => {
    const request = buildRequests(file).find((r) => r.id === 'au-revoir-selon-heure');
    expect(systemOf(request?.messages ?? []).content).toContain('15 h, après-midi');
  });
});
