import { describe, expect, it } from 'vitest';
import { PhraseSplitter, SayStreamExtractor } from '../stream/structured-turn/say-stream';
import {
  buildStructuredTurnJsonSchema,
  buildAfterActionJsonSchema,
  parseAfterActionOutput,
  parseStructuredTurnOutput,
  type StructuredTurnOutput,
} from '../stream/structured-turn/schema';
import { buildStructuredTurnMessages } from '../stream/structured-turn/prompt';
import {
  applyProposedDraft,
  authorizeStructuredAction,
  canResumeConfirmation,
  updateConfirmationState,
  bookingKey,
  createStructuredTurnState,
  parseStreamedDraft,
  outsideOpeningHoursFact,
  reconcileSpelledName,
  requestedSlotConflict,
  sizesWithoutTable,
  spelledLettersOf,
  spelledNameFact,
  todayInTimezone,
} from '../stream/structured-turn/fact-guards';

function output(overrides: Partial<StructuredTurnOutput> = {}): StructuredTurnOutput {
  return {
    turnComplete: true,
    interpretation: 'answer',
    draft: { date: '', time: '', partySize: 0, customerName: '' },
    awaiting: 'none',
    action: 'none',
    message: '',
    confidence: 'high',
    say: 'Bien sûr.',
    ...overrides,
  };
}

describe('SayStreamExtractor', () => {
  it('décode la phrase au fil des fragments, échappements compris', () => {
    const json = JSON.stringify({
      interpretation: 'question',
      action: 'none',
      say: 'Nous ouvrons à 19 h. C’est "parfait" ?\nVous voulez réserver ?',
    });
    const extractor = new SayStreamExtractor();
    let said = '';
    for (let index = 0; index < json.length; index += 3) {
      said += extractor.push(json.slice(index, index + 3));
    }
    expect(said).toBe('Nous ouvrons à 19 h. C’est "parfait" ? Vous voulez réserver ?');
  });

  it('ne renvoie rien avant l’ouverture de say', () => {
    const extractor = new SayStreamExtractor();
    expect(extractor.push('{"interpretation":"answer","action":"none",')).toBe('');
    expect(extractor.push('"say":"Bon')).toBe('Bon');
    expect(extractor.push('jour."}')).toBe('jour.');
  });
});

describe('PhraseSplitter', () => {
  it('rend les phrases complètes et garde la fin', () => {
    const splitter = new PhraseSplitter();
    expect(splitter.push('Parfait. Pour combien')).toEqual(['Parfait.']);
    expect(splitter.push(' de personnes ? Merci')).toEqual(['Pour combien de personnes ?']);
    expect(splitter.flush()).toBe('Merci');
  });

  it('early : rend le début de la première phrase dès sa première virgule, puis la suite comme une phrase', () => {
    const splitter = new PhraseSplitter();
    expect(splitter.push('Très bien, pour', { early: true })).toEqual(['Très bien,']);
    expect(splitter.early).toBe(true);
    expect(splitter.push(' combien de personnes ? Et', { early: true })).toEqual([
      'pour combien de personnes ?',
    ]);
    expect(splitter.early).toBe(false);
    // Une phrase est déjà sortie : plus de coupe à la virgule.
    expect(splitter.push(' le nom, s’il vous plaît', { early: true })).toEqual([]);
    expect(splitter.flush()).toBe('Et le nom, s’il vous plaît');
  });

  it('early : une phrase finie dans le même fragment part entière', () => {
    const splitter = new PhraseSplitter();
    expect(splitter.push('Très bien, c’est noté. Et', { early: true })).toEqual([
      'Très bien, c’est noté.',
    ]);
    expect(splitter.early).toBe(false);
  });

  it('early : jamais sur un début trop court, un nombre ou des lettres épelées', () => {
    expect(new PhraseSplitter().push('Oui, très', { early: true })).toEqual([]);
    expect(new PhraseSplitter().push('Oui, très bien, je', { early: true })).toEqual([
      'Oui, très bien,',
    ]);
    expect(new PhraseSplitter().push('Le 06 12, 34 56', { early: true })).toEqual([]);
    expect(new PhraseSplitter().push('Pour 12,5 personnes, ou', { early: true })).toEqual([]);
    expect(new PhraseSplitter().push('Je note A, S, S, A, M, M, c’est', { early: true })).toEqual(
      [],
    );
  });

  it('sans early : la virgule ne coupe rien (comportement actuel)', () => {
    const splitter = new PhraseSplitter();
    expect(splitter.push('Très bien, pour combien')).toEqual([]);
    expect(splitter.early).toBe(false);
  });
});

describe('parseStructuredTurnOutput', () => {
  it('accepte une sortie conforme et refuse une forme invalide', () => {
    expect(parseStructuredTurnOutput(JSON.stringify(output()))).toEqual(output());
    expect(parseStructuredTurnOutput('{"say":"x"}')).toBeNull();
    expect(parseStructuredTurnOutput('pas du json')).toBeNull();
  });
});

describe('vérification de compréhension', () => {
  const today = '2026-09-26';
  const previous = { date: '', time: '', partySize: 0, customerName: '' };
  const proposed = { date: '2026-09-27', time: '20:00', partySize: 0, customerName: '' };

  it('schéma : reading et understanding viennent avant le brouillon, seulement avec le drapeau', () => {
    const on = buildStructuredTurnJsonSchema(undefined, { understanding: true });
    const keys = Object.keys(on.properties);
    expect(keys.indexOf('reading')).toBeGreaterThan(keys.indexOf('turnComplete'));
    expect(keys.indexOf('understanding')).toBeLessThan(keys.indexOf('draft'));
    expect(on.required).toEqual(expect.arrayContaining(['reading', 'understanding']));
    const off = buildStructuredTurnJsonSchema();
    expect(Object.keys(off.properties)).not.toContain('reading');
    expect(off.required).not.toContain('understanding');
  });

  it("parse : garde reading et understanding quand ils sont là, et n'en ajoute pas sinon", () => {
    const withReading = output({ reading: 'lecture', understanding: 'doubtful' });
    expect(parseStructuredTurnOutput(JSON.stringify(withReading))).toEqual(withReading);
    expect(parseStructuredTurnOutput(JSON.stringify(output()))).not.toHaveProperty('understanding');
    const bad = { ...withReading, understanding: 'peut-être' };
    expect(parseStructuredTurnOutput(JSON.stringify(bad))).not.toHaveProperty('understanding');
  });

  it("doubtful : aucune valeur n'entre dans le brouillon, elles sont listées comme rejetées", () => {
    const result = applyProposedDraft(
      previous,
      output({ draft: proposed, understanding: 'doubtful', interpretation: 'unclear' }),
      { today },
    );
    expect(result.draft).toEqual(previous);
    expect(result.changed).toEqual([]);
    expect(result.rejected).toEqual(['date', 'time']);
  });

  it('clear ou absent : comportement inchangé', () => {
    for (const understanding of [undefined, 'clear' as const]) {
      const result = applyProposedDraft(
        previous,
        output({ draft: proposed, ...(understanding ? { understanding } : {}) }),
        { today },
      );
      expect(result.changed).toEqual(['date', 'time']);
    }
  });

  it('doubtful : aucune action, pas même une vérification de disponibilité', () => {
    const state = createStructuredTurnState();
    const draft = { date: '2026-09-27', time: '20:00', partySize: 2, customerName: '' };
    for (const action of ['check_availability', 'take_message', 'transfer', 'end_call'] as const) {
      expect(
        authorizeStructuredAction(state, output({ action, understanding: 'doubtful' }), draft, {
          maxPartySize: 7,
        }),
      ).toEqual({ allowed: false, reason: 'doubtful_understanding' });
    }
    expect(
      authorizeStructuredAction(state, output({ understanding: 'doubtful' }), draft, {
        maxPartySize: 7,
      }),
    ).toEqual({ allowed: true });
  });

  it("le prompt n'ajoute les consignes que sous le drapeau, et sans phrase à imiter", () => {
    const input = {
      systemPrompt: 'Tu es un agent.',
      history: [],
      transcript: 'bonjour',
      state: createStructuredTurnState(),
    };
    const off = buildStructuredTurnMessages(input)[0].content as string;
    const on = buildStructuredTurnMessages({ ...input, understanding: true })[0].content as string;
    expect(off).not.toContain('COMPRÉHENSION VÉRIFIÉE');
    expect(on).toContain('COMPRÉHENSION VÉRIFIÉE');
    // Aucun guillemet français dans le bloc : pas d'exemple de formulation.
    const block = on.slice(on.indexOf('COMPRÉHENSION VÉRIFIÉE'), on.indexOf('ÉTAT VÉRIFIÉ'));
    expect(block).not.toMatch(/[«»]/);
  });
});

describe('ton de voix (balise d’expression ElevenLabs)', () => {
  it('schéma : tone vient juste avant say, seulement avec le drapeau, dans une liste courte', () => {
    const on = buildStructuredTurnJsonSchema(undefined, { tone: true });
    const keys = Object.keys(on.properties);
    expect(keys.indexOf('tone')).toBe(keys.indexOf('say') - 1);
    expect(on.required).toContain('tone');
    expect((on.properties as unknown as Record<string, { enum?: string[] }>).tone.enum).toEqual([
      'none',
      'cheerful',
      'apologetic',
      'amused',
      'reassuring',
    ]);
    const off = buildStructuredTurnJsonSchema();
    expect(Object.keys(off.properties)).not.toContain('tone');
    expect(off.required).not.toContain('tone');
  });

  it('parse : garde un ton de la liste, ignore les autres', () => {
    const withTone = output({ tone: 'apologetic' });
    expect(parseStructuredTurnOutput(JSON.stringify(withTone))).toEqual(withTone);
    const bad = { ...output(), tone: 'warm' };
    expect(parseStructuredTurnOutput(JSON.stringify(bad))).not.toHaveProperty('tone');
  });

  it("le prompt n'ajoute les consignes de ton que sous le drapeau, sans phrase à imiter", () => {
    const input = {
      systemPrompt: 'Tu es un agent.',
      history: [],
      transcript: 'bonjour',
      state: createStructuredTurnState(),
    };
    const off = buildStructuredTurnMessages(input)[0].content as string;
    const on = buildStructuredTurnMessages({ ...input, tone: true })[0].content as string;
    expect(off).not.toContain('TON DE VOIX');
    expect(on).toContain('TON DE VOIX');
    const block = on.slice(on.indexOf('TON DE VOIX'), on.indexOf('ÉTAT VÉRIFIÉ'));
    expect(block).not.toMatch(/[«»]/);
  });
});

describe('ordre des champs : say reste en dernier', () => {
  // Mesuré le 19/11 sur le banc du moteur : placer say en premier ne fait partir le premier son qu'une fois
  // `action` lu (un fragment de gain, 217 contre 224 caractères sur 245). Les champs ci-dessous sont donc lus avant.
  it('turnComplete, compréhension, brouillon, awaiting, action et ton précèdent say', () => {
    const schema = buildStructuredTurnJsonSchema(undefined, { understanding: true, tone: true });
    const keys = Object.keys(schema.properties);
    expect(keys.at(-1)).toBe('say');
    for (const gate of ['turnComplete', 'understanding', 'draft', 'awaiting', 'action', 'tone']) {
      expect(keys.indexOf(gate)).toBeLessThan(keys.indexOf('say'));
    }
  });
});

describe('applyProposedDraft', () => {
  const today = '2026-09-26';

  it('garde la valeur précédente quand la proposition est invalide', () => {
    const previous = { date: '2026-09-27', time: '20:00', partySize: 4, customerName: '' };
    const result = applyProposedDraft(
      previous,
      output({ draft: { date: '2026-09-20', time: '25:00', partySize: 4, customerName: 'A2KIF' } }),
      { today },
    );
    expect(result.draft).toEqual(previous);
    expect(result.rejected.sort()).toEqual(['customerName', 'date', 'time']);
  });

  it('n’efface une valeur que sur une correction', () => {
    const previous = { date: '2026-09-27', time: '20:00', partySize: 4, customerName: '' };
    const blank = { date: '', time: '', partySize: 0, customerName: '' };
    expect(applyProposedDraft(previous, output({ draft: blank }), { today }).draft).toEqual(
      previous,
    );
    expect(
      applyProposedDraft(previous, output({ draft: blank, interpretation: 'correction' }), {
        today,
      }).draft,
    ).toEqual(blank);
  });
});

describe('authorizeStructuredAction : congé après la réservation', () => {
  const draft = { date: '2026-09-27', time: '20:00', partySize: 2, customerName: 'Houet' };
  const created = () => ({ ...createStructuredTurnState(), reservationCreated: true });
  const decide = (
    state: ReturnType<typeof createStructuredTurnState>,
    extra: Partial<ReturnType<typeof output>>,
    transcriptWords?: number,
  ) =>
    authorizeStructuredAction(state, output({ action: 'end_call', ...extra }), draft, {
      maxPartySize: 7,
      ...(transcriptWords !== undefined ? { transcriptWords } : {}),
    });

  it('un énoncé court que le modèle ne comprend pas est un au revoir mal transcrit : on raccroche', () => {
    expect(decide(created(), { understanding: 'doubtful' }, 2)).toEqual({ allowed: true });
    expect(decide(created(), { understanding: 'doubtful' }, 6)).toEqual({ allowed: true });
  });

  it('un mot mal transcrit donne une confiance faible : le congé court passe quand même', () => {
    // Mesuré à travers le moteur : sans cela « dix nous » ne raccrochait jamais (0 % sur 12 tirages).
    expect(decide(created(), { understanding: 'doubtful', confidence: 'low' }, 2)).toEqual({
      allowed: true,
    });
    expect(decide(created(), { confidence: 'low', interpretation: 'unclear' }, 2)).toEqual({
      allowed: true,
    });
  });

  it('la confiance faible refuse toujours un congé long, ou après une question, ou sans réservation', () => {
    expect(decide(created(), { confidence: 'low' }, 9)).toEqual({
      allowed: false,
      reason: 'low_confidence',
    });
    expect(decide({ ...created(), lastAwaiting: 'open' }, { confidence: 'low' }, 2)).toEqual({
      allowed: false,
      reason: 'low_confidence',
    });
    expect(decide(createStructuredTurnState(), { confidence: 'low' }, 2)).toEqual({
      allowed: false,
      reason: 'low_confidence',
    });
  });

  it('un énoncé long jugé douteux n’est pas un au revoir : refusé', () => {
    expect(decide(created(), { understanding: 'doubtful' }, 7)).toEqual({
      allowed: false,
      reason: 'doubtful_understanding',
    });
    // Nombre de mots inconnu : prudence, refusé.
    expect(decide(created(), { understanding: 'doubtful' })).toEqual({
      allowed: false,
      reason: 'doubtful_understanding',
    });
  });

  it('après une question ouverte de l’agent (« Autre chose ? »), un court énoncé douteux est peut-être une vraie question : refusé', () => {
    for (const lastAwaiting of ['open', 'date', 'confirmation', 'customerName'] as const) {
      const state = { ...created(), lastAwaiting };
      expect(decide(state, { understanding: 'doubtful' }, 2)).toEqual({
        allowed: false,
        reason: 'doubtful_understanding',
      });
    }
    // Un congé que le modèle a compris reste autorisé après une question ouverte.
    expect(decide({ ...created(), lastAwaiting: 'open' }, { understanding: 'clear' }, 2)).toEqual({
      allowed: true,
    });
  });

  it('sans réservation créée, un doute reste un doute : rien ne se ferme', () => {
    expect(decide(createStructuredTurnState(), { understanding: 'doubtful' }, 2)).toEqual({
      allowed: false,
      reason: 'doubtful_understanding',
    });
  });

  it('l’exception ne vaut que pour le congé, pas pour une autre action', () => {
    for (const action of ['check_availability', 'take_message', 'transfer'] as const) {
      expect(decide(created(), { action, understanding: 'doubtful' }, 2)).toEqual({
        allowed: false,
        reason: 'doubtful_understanding',
      });
    }
  });

  it('sans vérification de compréhension : un congé long que le modèle dit ne pas avoir compris est refusé', () => {
    expect(decide(created(), { interpretation: 'unclear' }, 12)).toEqual({
      allowed: false,
      reason: 'long_unclear_farewell',
    });
    expect(decide(created(), { interpretation: 'unclear' }, 2)).toEqual({ allowed: true });
    expect(decide(created(), { interpretation: 'end_call', understanding: 'clear' }, 12)).toEqual({
      allowed: true,
    });
  });
});

describe('authorizeStructuredAction', () => {
  const draft = { date: '2026-09-27', time: '20:00', partySize: 4, customerName: 'Akkif' };
  const verifiedState = () => ({
    ...createStructuredTurnState(),
    draft,
    availability: { date: draft.date, partySize: 4, slots: ['19:30', '20:00'] },
  });

  it('refuse la création sans récapitulatif lu au tour précédent', () => {
    const decision = authorizeStructuredAction(
      verifiedState(),
      output({ action: 'create_reservation', interpretation: 'affirmation' }),
      draft,
      { maxPartySize: 7 },
    );
    expect(decision).toEqual({ allowed: false, reason: 'recap_not_read' });
  });

  it('autorise la création après un récapitulatif accepté sur un créneau vérifié', () => {
    const state = { ...verifiedState(), lastAwaiting: 'confirmation' as const };
    state.recapKey = bookingKey(draft);
    expect(
      authorizeStructuredAction(
        state,
        output({ action: 'create_reservation', interpretation: 'affirmation' }),
        draft,
        { maxPartySize: 7 },
      ),
    ).toEqual({ allowed: true });
  });

  it('refuse un récapitulatif différent du brouillon ou un créneau non vérifié', () => {
    const state = { ...verifiedState(), lastAwaiting: 'confirmation' as const };
    state.recapKey = bookingKey({ ...draft, time: '19:30' });
    expect(
      authorizeStructuredAction(
        state,
        output({ action: 'create_reservation', interpretation: 'affirmation' }),
        draft,
        { maxPartySize: 7 },
      ),
    ).toEqual({ allowed: false, reason: 'recap_not_read' });
    const unverified = { ...state, recapKey: bookingKey(draft), availability: null };
    expect(
      authorizeStructuredAction(
        unverified,
        output({ action: 'create_reservation', interpretation: 'affirmation' }),
        draft,
        { maxPartySize: 7 },
      ),
    ).toEqual({ allowed: false, reason: 'slot_not_verified' });
  });

  it('refuse toute action à effet sur un plan peu sûr', () => {
    expect(
      authorizeStructuredAction(
        verifiedState(),
        output({ action: 'end_call', confidence: 'low' }),
        draft,
        { maxPartySize: 7 },
      ),
    ).toEqual({ allowed: false, reason: 'low_confidence' });
  });
});

describe('todayInTimezone', () => {
  it('suit le fuseau du restaurant', () => {
    expect(todayInTimezone('Europe/Paris', new Date('2026-09-25T23:30:00Z'))).toBe('2026-09-26');
  });
});

describe('créneau demandé et disponibilités lues', () => {
  const day = {
    date: '2026-09-30',
    closed: false,
    slotsBySize: { 5: ['12:00', '18:30'], 2: [] as string[] },
  };
  const draft = (over: Partial<{ date: string; time: string; partySize: number }> = {}) => ({
    date: '2026-09-30',
    time: '15:30',
    partySize: 5,
    ...over,
  });

  it('signale un créneau absent des disponibilités du groupe, jamais quand on ne sait pas', () => {
    expect(requestedSlotConflict(day, draft())).toBe(true);
    expect(requestedSlotConflict(day, draft({ time: '18:30' }))).toBe(false);
    // Aucun créneau pour ce nombre : l'heure demandée n'y est pas non plus.
    expect(requestedSlotConflict(day, draft({ partySize: 2 }))).toBe(true);
    // Inconnu : jour non lu, autre jour, groupe hors lecture, brouillon incomplet.
    expect(requestedSlotConflict(null, draft())).toBe(false);
    expect(requestedSlotConflict(day, draft({ date: '2026-10-01' }))).toBe(false);
    expect(requestedSlotConflict(day, draft({ partySize: 9 }))).toBe(false);
    expect(requestedSlotConflict(day, draft({ time: '' }))).toBe(false);
    expect(requestedSlotConflict(day, draft({ partySize: 0 }))).toBe(false);
  });

  it('lit le brouillon dans un flux JSON partiel, avant la première phrase', () => {
    const streamed =
      '{"turnComplete":true,"interpretation":"answer","draft":{"date":"2026-09-30","time":"15:30","partySize":5,"customerName":""},"awaiting":"none"';
    expect(parseStreamedDraft(streamed)).toEqual({
      date: '2026-09-30',
      time: '15:30',
      partySize: 5,
    });
    // Tant que l'objet n'est pas fermé, rien n'est lisible.
    expect(parseStreamedDraft('{"turnComplete":true,"draft":{"date":"2026-09-30","ti')).toBeNull();
    expect(parseStreamedDraft('')).toBeNull();
  });
});

describe('outsideOpeningHoursFact', () => {
  const hours = {
    tue: { open: '12:00', close: '14:30' },
    sat: { open: '12:00', close: '23:00' },
    fri: { open: '18:00', close: '02:00' },
  };
  // 2026-10-06 est un mardi, 2026-10-10 un samedi, 2026-10-09 un vendredi, 2026-10-05 un lundi.
  it('donne le fait quand l’heure sort du service d’un jour ouvert', () => {
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '20:00' })).toContain(
      'en dehors des horaires du mardi (12:00–14:30)',
    );
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '11:00' })).not.toBeNull();
  });

  it('reconnaît aussi les heures hors service entre le déjeuner et le dîner', () => {
    const splitHours = {
      tue: {
        open: '12:00',
        close: '22:30',
        services: [
          { open: '12:00', close: '14:30' },
          { open: '19:00', close: '22:30' },
        ],
      },
    };
    expect(outsideOpeningHoursFact(splitHours, { date: '2026-10-06', time: '16:00' })).toContain(
      '(12:00–14:30 puis 19:00–22:30)',
    );
    expect(outsideOpeningHoursFact(splitHours, { date: '2026-10-06', time: '20:00' })).toBeNull();
  });

  it('refuse une heure après la dernière réservation fixée du service', () => {
    const withLastBooking = {
      tue: {
        open: '12:00',
        close: '22:30',
        slots: [
          { open: '12:00', close: '14:30', lastBooking: '14:00' },
          { open: '19:00', close: '22:30', lastBooking: '21:30' },
        ],
      },
    };
    expect(
      outsideOpeningHoursFact(withLastBooking, { date: '2026-10-06', time: '22:00' }),
    ).toContain('après la dernière réservation du mardi pour ce service (21:30');
    expect(
      outsideOpeningHoursFact(withLastBooking, { date: '2026-10-06', time: '14:30' }),
    ).toContain("jusqu'à 14:00");
    expect(
      outsideOpeningHoursFact(withLastBooking, { date: '2026-10-06', time: '21:30' }),
    ).toBeNull();
    // Sans dernière réservation fixée, le comportement historique est conservé.
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '14:30' })).toBeNull();
  });

  it('reste muet quand tout est compatible ou inconnu', () => {
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '12:00' })).toBeNull();
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '14:30' })).toBeNull();
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-10', time: '21:00' })).toBeNull();
    // Jour fermé : le calendrier donné au modèle le dit déjà.
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-05', time: '20:00' })).toBeNull();
    // Service de nuit (fermeture après minuit) : non tranché ici.
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-09', time: '23:30' })).toBeNull();
    expect(outsideOpeningHoursFact(null, { date: '2026-10-06', time: '20:00' })).toBeNull();
    expect(outsideOpeningHoursFact(hours, { date: '', time: '20:00' })).toBeNull();
    expect(outsideOpeningHoursFact(hours, { date: '2026-10-06', time: '' })).toBeNull();
  });
});

describe('reconcileSpelledName', () => {
  const draft = (customerName: string) => ({ date: '', time: '', partySize: 0, customerName });

  it('reads letters and doubles like a caller spells them', () => {
    expect(spelledLettersOf('hoët h o u e t')).toBe('HOUET');
    expect(spelledLettersOf('au nom de a 2 k i f')).toBe('AKKIF');
    expect(spelledLettersOf('4 1 non 5 5')).toBe('');
    expect(spelledLettersOf('oui')).toBe('');
  });

  it('restores letters the model dropped from the name it wrote', () => {
    expect(reconcileSpelledName(draft('Hoët'), 'hoët h o u e t', 'customerName').customerName).toBe(
      'Houet',
    );
    expect(reconcileSpelledName(draft('HOËT'), 'non h o u e t', 'confirmation').customerName).toBe(
      'HOUET',
    );
    expect(
      reconcileSpelledName(draft('AKIF'), 'au nom de a 2 k i f', 'customerName').customerName,
    ).toBe('AKKIF');
  });

  it('leaves a name that already matches, or a false start followed by the right spelling', () => {
    expect(reconcileSpelledName(draft('HOUET'), 'h o u e t', 'customerName').customerName).toBe(
      'HOUET',
    );
    expect(
      reconcileSpelledName(draft('AKKIF'), 'a k f a 2 k i f', 'customerName').customerName,
    ).toBe('AKKIF');
  });

  it('never shortens or replaces a name built over several turns', () => {
    expect(reconcileSpelledName(draft('HOUET'), 'u e t', 'customerName').customerName).toBe(
      'HOUET',
    );
    expect(reconcileSpelledName(draft('Durand'), 'h o u e t', 'customerName').customerName).toBe(
      'Durand',
    );
  });

  it('drops the words glued after the spelling, whatever they are', () => {
    // La garde ne connaît aucun mot : seule la structure compte (lettres épelées + reste séparé).
    for (const glued of ['HOUET DIMANCHE', 'HOUET oui', 'HOUET je souhaite', 'HOUET x']) {
      expect(reconcileSpelledName(draft(glued), 'h o u e t bla', 'customerName').customerName).toBe(
        'HOUET',
      );
    }
    expect(
      reconcileSpelledName(draft('Hoët Houet'), 'hoët h o u e t merci', 'customerNameConfirmation')
        .customerName,
    ).toBe('Hoët Houet');
    expect(
      reconcileSpelledName(draft('Houet Dimanche'), 'h o u e t dimanche', 'confirmation')
        .customerName,
    ).toBe('Houet');
  });

  it('keeps a longer name when it is not the spelling followed by separate words', () => {
    // Complété sans séparation : le modèle a deviné la fin, ce n'est pas un mot collé.
    expect(reconcileSpelledName(draft('DUPONT'), 'd u p o n', 'customerName').customerName).toBe(
      'DUPONT',
    );
    // Reste AVANT l'épellation : pièces d'un nom assemblées sur plusieurs tours.
    expect(reconcileSpelledName(draft('AK KIF'), 'k i f', 'customerName').customerName).toBe(
      'AK KIF',
    );
    expect(
      reconcileSpelledName(draft('Jean HOUET'), 'h o u e t', 'customerName').customerName,
    ).toBe('Jean HOUET');
    // Le nom est exactement l'épellation en plusieurs mots : rien de plus.
    expect(
      reconcileSpelledName(draft('DE LA FONTAINE'), 'd e l a f o n t a i n e', 'customerName')
        .customerName,
    ).toBe('DE LA FONTAINE');
  });

  it('spelledNameFact : dit quand le nom relu diffère des lettres épelées, sans connaître aucun mot', () => {
    const fact = (
      name: string,
      said: string,
      awaiting: StructuredTurnOutput['awaiting'] = 'customerName',
    ) => spelledNameFact(name, said, awaiting);
    // Lettre absente, mot entendu qui l'emporte sur les lettres, mot collé derrière.
    expect(fact('AKIF', 'a 2 k i f')).toContain('customerName = « AKKIF »');
    expect(fact('Hoët', 'hoët h o u e t')).toContain('customerName = « Houet »');
    expect(fact('HOUET DIMANCHE', 'h o u e t dimanche')).toContain('customerName = « HOUET »');
    // Les mêmes lettres, autre casse ou mise en forme : rien à dire.
    expect(fact('HOUET', 'h o u e t')).toBeNull();
    expect(fact('Houet', 'h o u e t')).toBeNull();
    // Mêmes limites que le garde-fou : nom assemblé sur plusieurs tours, nom complété, pas d'épellation.
    expect(fact('AK KIF', 'k i f')).toBeNull();
    expect(fact('DUPONT', 'd u p o n')).toBeNull();
    expect(fact('Durand', 'oui merci')).toBeNull();
    expect(fact('Hoët', 'h o u e t', 'date')).toBeNull();
  });

  it('a clear spelling wins over the model name even at equal length (a digit read as a letter)', () => {
    // « a 2 k i f » : le modèle lit parfois le « 2 » comme un second A (même longueur, une lettre fausse).
    expect(
      reconcileSpelledName(draft('AAKIF'), 'au nom de a 2 k i f', 'customerName').customerName,
    ).toBe('AKKIF');
    expect(
      reconcileSpelledName(draft('Aakif'), 'au nom de a 2 k i f', 'customerName').customerName,
    ).toBe('Akkif');
    // Toutes les lectures enregistrées d'un même énoncé aboutissent aux mêmes lettres.
    for (const read of ['A2KIF', 'AKIF', 'AAKIF', 'AKKIF', 'Akkif']) {
      const fixed = reconcileSpelledName(draft(read), 'au nom de a 2 k i f', 'customerName');
      expect(fixed.customerName.toUpperCase()).toBe('AKKIF');
    }
    expect(spelledNameFact('AAKIF', 'a 2 k i f', 'customerName')).toContain(
      'customerName = « AKKIF »',
    );
  });

  it('keeps the model name when the spelling is ambiguous or the names are too different', () => {
    // Deux épellations dans la phrase : laquelle est la bonne n'est pas une question de code.
    expect(
      reconcileSpelledName(draft('HOUET'), 'h o u e t non h a u e t', 'customerName').customerName,
    ).toBe('HOUET');
    // Même longueur mais un autre nom : le modèle sait peut-être ce qu'il fait.
    expect(reconcileSpelledName(draft('MARTI'), 'h o u e t', 'customerName').customerName).toBe(
      'MARTI',
    );
    // Un nom déjà connu avant ce tour (assemblé sur plusieurs tours) n'est pas remplacé à longueur égale.
    expect(
      reconcileSpelledName(draft('AAKIF'), 'a 2 k i f', 'customerName', 'DURAND').customerName,
    ).toBe('AAKIF');
  });

  it('does nothing when no name was being asked for', () => {
    expect(reconcileSpelledName(draft('Hoët'), 'h o u e t', 'date').customerName).toBe('Hoët');
  });
});

describe('reprise de la fin du nom après la relecture (épellation partielle)', () => {
  const draft = (customerName: string) => ({ date: '', time: '', partySize: 0, customerName });
  const merged = (previous: string, said: string, proposed = previous) =>
    reconcileSpelledName(draft(proposed), said, 'customerNameConfirmation', previous).customerName;

  // Quelques lettres après la relecture : l'alignement est une opération de chaîne (distance d'édition),
  // pas de sens ; la relecture de confirmation qui suit protège d'une erreur d'alignement.
  it.each([
    ['HOUT', 'e t', 'HOUET'],
    ['HOUT', 'u e t', 'HOUET'],
    ['BENANI', 'n n a n i', 'BENNANI'],
    ['AKKI', 'f', 'AKKIF'],
    ['AKKI', 'i f', 'AKKIF'],
    ['DUPON', 'n t', 'DUPONT'],
  ])('« %s » relu, l’appelant dit « %s » : le nom devient %s', (previous, said, expected) => {
    // Le modèle recolle à la suite (ou ne change rien) : le garde-fou remet l'alignement.
    expect(merged(previous, said, previous + said.replace(/ /g, ''))).toBe(expected);
    expect(merged(previous, said)).toBe(expected);
  });

  it('ne change rien quand les lettres répètent la fin déjà relue', () => {
    expect(merged('HOUET', 'e t', 'HOUETET')).toBe('HOUET');
    expect(merged('AKKIF', 'f', 'AKKIFF')).toBe('AKKIF');
  });

  it('remplace le nom quand l’appelant reprend toute l’épellation, ou donne un autre nom', () => {
    expect(merged('HOUT', 'h o u e t')).toBe('HOUET');
    expect(merged('HOUT', 'm a r t i n')).toBe('MARTIN');
  });

  it('garde la casse du nom relu', () => {
    expect(merged('Hout', 'e t', 'Houtet')).toBe('Houet');
    expect(merged('HOUT', 'e t', 'HOUTET')).toBe('HOUET');
  });

  it('ne s’applique que sur des lettres seules, juste après la relecture d’un nom', () => {
    // Un mot avec les lettres (« non e t ») : la phrase reste au modèle.
    expect(merged('HOUT', 'non e t', 'HOUTET')).toBe('HOUTET');
    // « et » est un mot, pas deux lettres épelées.
    expect(merged('HOUT', 'et', 'HOUTET')).toBe('HOUTET');
    // Pas après la relecture : on collecte encore le nom.
    expect(reconcileSpelledName(draft('HOUTET'), 'e t', 'customerName', 'HOUT').customerName).toBe(
      'HOUTET',
    );
    // Sans nom relu connu.
    expect(
      reconcileSpelledName(draft('HOUTET'), 'e t', 'customerNameConfirmation').customerName,
    ).toBe('HOUTET');
  });

  it('donne au modèle le fait à relire quand son nom n’est pas celui de l’alignement', () => {
    const fact = spelledNameFact('HOUTE', 'e t', 'customerNameConfirmation', 'HOUT');
    expect(fact).toContain('HOUET');
    expect(fact).toContain('HOUTE');
    expect(spelledNameFact('HOUET', 'e t', 'customerNameConfirmation', 'HOUT')).toBeNull();
  });
});

describe('aucune table pour ce nombre, distinct de « complet ce jour-là » (appel 03b19223)', () => {
  const ranges = [
    { capacity: 2, minCapacity: 1 },
    { capacity: 4, minCapacity: 1 },
    { capacity: 6, minCapacity: 2 },
  ];

  it('liste les tailles qu’aucune table n’accueille, avec le critère de la disponibilité', () => {
    expect(sizesWithoutTable(ranges, 10)).toEqual([7, 8, 9, 10]);
    // Une table qui n’accueille qu’à partir de 4 laisse un trou en dessous.
    expect(sizesWithoutTable([{ capacity: 6, minCapacity: 4 }], 7)).toEqual([1, 2, 3, 7]);
    // Aucune table connue : rien n’est affirmé.
    expect(sizesWithoutTable([], 10)).toEqual([]);
  });

  it('le dit au modèle par une ligne « aucune table », et « aucun » reste pour le jour complet', () => {
    const state = createStructuredTurnState();
    state.draft = { date: '2026-10-03', time: '20:00', partySize: 7, customerName: '' };
    state.dayAvailability = {
      date: '2026-10-03',
      closed: false,
      slotsBySize: { 1: ['20:00'], 2: [], 3: [], 4: ['20:00'], 5: [], 6: [], 7: [], 8: [] },
      noTableSizes: [7, 8],
    };
    const [system] = buildStructuredTurnMessages({
      systemPrompt: 'Prompt',
      history: [],
      transcript: 'on sera sept',
      state,
    });
    const verified = JSON.parse(String(system.content).split('ÉTAT VÉRIFIÉ : ')[1].split('\n')[0]);
    expect(verified.dayAvailability.freeSlotsByPartySize).toEqual({
      '1': '20:00',
      '2-3': 'aucun',
      '4': '20:00',
      '5-6': 'aucun',
      '7-8': 'aucune table',
    });
  });
});

describe('reprise de confirmation après une parenthèse', () => {
  const draft = { date: '2026-10-27', time: '20:00', partySize: 3, customerName: 'Test' };
  function state(): ReturnType<typeof createStructuredTurnState> {
    return {
      ...createStructuredTurnState(),
      draft: { ...draft },
      availability: { date: draft.date, partySize: draft.partySize, slots: ['20:00', '20:30'] },
      lastAwaiting: 'confirmation' as const,
      recapKey: bookingKey(draft),
    };
  }
  function creation(s: ReturnType<typeof createStructuredTurnState>) {
    return authorizeStructuredAction(
      s,
      output({ action: 'create_reservation', interpretation: 'affirmation' }),
      s.draft,
      { maxPartySize: 12 },
    );
  }

  it('conserve le récapitulatif entendu pendant la proposition de transfert, sans autoriser le oui au transfert', () => {
    const s = state();
    updateConfirmationState(
      s,
      output({ interpretation: 'question', awaiting: 'humanFallback' }),
      true,
    );
    expect(canResumeConfirmation(s)).toBe(true);
    expect(creation(s)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
    updateConfirmationState(
      s,
      output({ interpretation: 'decline', awaiting: 'confirmationResume' }),
      true,
    );
    expect(creation(s)).toEqual({ allowed: true });
  });

  it('ne mémorise pas un récapitulatif coupé avant la fin de son contenu', () => {
    const s = state();
    updateConfirmationState(
      s,
      output({ interpretation: 'question', awaiting: 'humanFallback' }),
      false,
    );
    updateConfirmationState(
      s,
      output({ interpretation: 'decline', awaiting: 'confirmationResume' }),
      true,
    );
    expect(canResumeConfirmation(s)).toBe(false);
    expect(creation(s)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
  });

  it.each(['date', 'time', 'partySize', 'customerName'] as const)(
    'invalide la reprise si %s change',
    (field) => {
      const s = state();
      updateConfirmationState(s, output({ interpretation: 'question', awaiting: 'open' }), true);
      const changed = { date: '2026-10-28', time: '20:30', partySize: 4, customerName: 'Autre' };
      s.draft = { ...s.draft, [field]: changed[field] };
      s.availability = {
        date: s.draft.date,
        partySize: s.draft.partySize,
        slots: ['20:00', '20:30'],
      };
      updateConfirmationState(
        s,
        output({ interpretation: 'correction', awaiting: 'confirmationResume' }),
        true,
      );
      expect(creation(s)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
    },
  );

  it('un refus de réserver invalide la reprise, contrairement au refus de transfert', () => {
    const s = state();
    updateConfirmationState(s, output({ interpretation: 'decline', awaiting: 'open' }), true);
    updateConfirmationState(s, output({ awaiting: 'confirmationResume' }), true);
    expect(creation(s)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
  });

  it('ne transforme pas un oui à une autre question en accord de réservation', () => {
    const s = state();
    updateConfirmationState(s, output({ interpretation: 'question', awaiting: 'open' }), true);
    expect(canResumeConfirmation(s)).toBe(true);
    expect(creation(s)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
  });

  it('ne permet pas de reprise sans récapitulatif antérieur ni sans disponibilité vérifiée', () => {
    const empty = createStructuredTurnState();
    empty.draft = { ...draft };
    empty.lastAwaiting = 'confirmationResume';
    empty.availability = { date: draft.date, partySize: draft.partySize, slots: ['20:00'] };
    expect(creation(empty)).toMatchObject({ allowed: false, reason: 'recap_not_read' });
    const s = state();
    updateConfirmationState(s, output({ awaiting: 'confirmationResume' }), true);
    s.availability = null;
    expect(creation(s)).toMatchObject({ allowed: false, reason: 'slot_not_verified' });
  });
});

describe('formulation après une opération terminée', () => {
  const draft = { date: '2026-10-27', time: '20:00', partySize: 4, customerName: 'Martin' };
  const reply = { awaiting: 'none', action: 'none', confidence: 'high', say: 'C’est réservé.' };

  it('ne génère ni brouillon ni compréhension et garde say en dernier', () => {
    const schema = buildAfterActionJsonSchema({ tone: true });
    expect(Object.keys(schema.properties)).toEqual([
      'awaiting',
      'action',
      'confidence',
      'tone',
      'say',
    ]);
    expect(schema.properties.action.enum).toEqual(['none', 'end_call']);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(buildAfterActionJsonSchema().properties).not.toHaveProperty('tone');
  });

  it('adapte la réponse sans permettre de modifier les faits', () => {
    const parsed = parseAfterActionOutput(JSON.stringify(reply), draft)!;
    expect(parsed.draft).toEqual(draft);
    expect(parsed.draft).not.toBe(draft);
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.say).toBe(reply.say);
    expect(parsed.understanding).toBe('clear');
    expect(parseAfterActionOutput(JSON.stringify(reply), draft, 'decline')?.interpretation).toBe(
      'decline',
    );
    expect(
      parseAfterActionOutput(JSON.stringify(reply), draft, 'new_request')?.interpretation,
    ).toBe('new_request');
    expect(
      parseAfterActionOutput(
        JSON.stringify({ ...reply, action: 'end_call', confidence: 'low' }),
        draft,
      ),
    ).toMatchObject({ action: 'end_call', confidence: 'low', interpretation: 'end_call' });
  });

  it.each([
    null,
    [],
    { ...reply, action: 'create_reservation' },
    { ...reply, action: 'transfer' },
    { ...reply, draft },
    { ...reply, turnComplete: false },
    { ...reply, message: 'autre' },
    { ...reply, awaiting: 'inconnu' },
    { ...reply, confidence: 'certain' },
    { ...reply, tone: 'angry' },
    { ...reply, say: null },
    { ...reply, awaiting: undefined },
  ])('rejette une sortie invalide ou une tentative de nouvelle action : %j', (value) => {
    expect(parseAfterActionOutput(JSON.stringify(value), draft)).toBeNull();
  });

  it('rejette un JSON tronqué et conserve un ton autorisé', () => {
    expect(parseAfterActionOutput('{', draft)).toBeNull();
    expect(
      parseAfterActionOutput(JSON.stringify({ ...reply, tone: 'reassuring' }), draft)?.tone,
    ).toBe('reassuring');
  });
});
