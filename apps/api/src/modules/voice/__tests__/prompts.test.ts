import { VOICE_CONVERSATION_RULES } from '../conversation-rules';
import { describe, it, expect } from 'vitest';
import { agentVoiceGender, buildSystemPrompt, formatOpeningHours } from '../prompts';
import {
  buildStructuredTurnMessages,
  describeCalendar,
  describeDate,
} from '../stream/structured-turn/prompt';
import {
  createStructuredTurnState,
  dayPartInTimezone,
} from '../stream/structured-turn/fact-guards';
import { systemOf } from './helpers/system-of';

describe('buildSystemPrompt', () => {
  const baseCtx = {
    name: 'Chez Michel',
    openingHours: {
      mon: { open: '12:00', close: '14:30' },
      tue: { open: '12:00', close: '14:30' },
      wed: { open: '12:00', close: '14:30' },
      thu: { open: '12:00', close: '14:30' },
      fri: { open: '12:00', close: '14:30' },
      sat: { open: '19:00', close: '23:00' },
      sun: null,
    },
    personality: null,
  };

  it('partage une seule règle de continuité et de récapitulatif avec le tour structuré', () => {
    const prompt = buildSystemPrompt(baseCtx, new Date('2026-10-26T10:00:00Z'));
    for (const systemPrompt of [prompt, 'Prompt de test']) {
      const system = systemOf(
        buildStructuredTurnMessages({
          systemPrompt,
          history: [],
          transcript: 'et demain, vous avez une terrasse ?',
          state: createStructuredTurnState(),
        }),
      );
      expect(system.content.split(VOICE_CONVERSATION_RULES)).toHaveLength(2);
      expect(system.content).not.toContain('la date complète seulement au récapitulatif');
      expect(system.content).toContain('Si le jour est éloigné ou ambigu');
      expect(system.content).toContain('retiens la valeur, réponds à sa question');
      expect(system.content).toContain('canResumeConfirmation=true');
      expect(system.content).toContain('create_reservation uniquement');
    }
  });

  it('après opération demande uniquement la formulation, sans nouveau brouillon', () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: buildSystemPrompt(baseCtx),
        history: [],
        transcript: 'demain pour quatre',
        state: createStructuredTurnState(),
        afterAction: true,
        understanding: true,
        actionResult: 'La vérification a échoué. Aucun horaire vérifié.',
      }),
    );
    expect(system.content).toContain('RÉPONSE APRÈS UNE OPÉRATION TERMINÉE');
    expect(system.content).not.toContain('MODE DE RÉPONSE STRUCTURÉ');
    expect(system.content).not.toContain('COMPRÉHENSION VÉRIFIÉE');
    expect(system.content).toContain(
      'Ne promets jamais une réussite si le résultat indique un échec',
    );
    expect(system.content).toContain('La vérification a échoué');
  });

  it.each([
    [undefined, 8],
    [7, 8],
    [10, 11],
  ])('cite le seuil de groupe du restaurant (maxPartySize %s)', (maxPartySize, threshold) => {
    const prompt = buildSystemPrompt(
      { ...baseCtx, maxPartySize },
      new Date('2026-07-22T10:00:00Z'),
    );

    expect(prompt).toContain(`groupe de ${threshold} personnes ou plus`);
    expect(prompt).not.toContain('8+');
  });

  describe('style de la maison (Style et Ton de voix de l’onboarding)', () => {
    const styled = (
      personality: { profileType?: string; fillerStyle?: string } | null,
      personalityStyleEnabled = true,
    ) => buildSystemPrompt({ ...baseCtx, personality, personalityStyleEnabled });

    it('laisse le prompt strictement inchangé quand le drapeau est coupé', () => {
      const reference = buildSystemPrompt(baseCtx);
      expect(styled({ profileType: 'GASTRONOMIQUE', fillerStyle: 'FORMAL' }, false)).toBe(
        reference,
      );
    });

    it('laisse le prompt inchangé pour le réglage par défaut (bistrot, naturel)', () => {
      const reference = buildSystemPrompt(baseCtx);
      expect(styled({ profileType: 'BISTROT_BRASSERIE', fillerStyle: 'CASUAL' })).toBe(reference);
      expect(styled(null)).toBe(reference);
    });

    it('règle les mots et la politesse, jamais le rythme : la maison reste une conversation téléphonique', () => {
      const prompt = styled({ profileType: 'GASTRONOMIQUE', fillerStyle: 'FORMAL' });
      expect(prompt).toContain('jamais le rythme');
      expect(prompt).toContain('on parle, on ne rédige pas');
    });

    it('la politesse du ton formel est présente sans se répéter d’un tour à l’autre', () => {
      expect(styled({ fillerStyle: 'FORMAL' })).toContain("ne se répète pas d'un tour à l'autre");
    });

    it('garde mot pour mot le ton chaleureux (réglage validé)', () => {
      expect(styled({ fillerStyle: 'WARM' })).toContain(
        "- Ton de voix : chaleureux et convivial. Tu fais sentir à l'appelant qu'il est le bienvenu : quand sa demande s'y prête, une courte marque d'attention personnelle avant d'enchaîner, dite simplement, sans point d'exclamation ni formule toute faite répétée d'un tour à l'autre.",
      );
    });

    it.each([
      [{ profileType: 'SEMI_GASTRO' }, 'semi-gastronomique'],
      [{ profileType: 'GASTRONOMIQUE' }, 'gastronomique'],
      [{ fillerStyle: 'WARM' }, 'chaleureux et convivial'],
      [{ fillerStyle: 'FORMAL' }, 'formel et soigné'],
    ])('ajoute le registre de %j', (personality, expected) => {
      const prompt = styled(personality);
      expect(prompt).toContain('REGISTRE DE LA MAISON');
      expect(prompt).toContain(expected);
    });

    it('cumule le style et le ton, et garde la brièveté et les règles de réservation', () => {
      const prompt = styled({ profileType: 'GASTRONOMIQUE', fillerStyle: 'FORMAL' });
      expect(prompt.match(/^- Maison gastronomique/m)).not.toBeNull();
      expect(prompt.match(/^- Ton de voix/m)).not.toBeNull();
      expect(prompt).toContain('la brièveté et les règles de réservation ne changent pas');
      expect(prompt.indexOf('REGISTRE DE LA MAISON')).toBeLessThan(prompt.indexOf('DATE COURANTE'));
    });
  });

  it('liste un jour absent des horaires comme fermé, dans l’ordre de la semaine', () => {
    const hours = formatOpeningHours({
      fri: { open: '12:00', close: '23:00' },
      tue: { open: '12:00', close: '22:00' },
    });
    expect(hours.split('\n')).toEqual([
      'Lundi : fermé',
      'Mardi : 12:00–22:00',
      'Mercredi : fermé',
      'Jeudi : fermé',
      'Vendredi : 12:00–23:00',
      'Samedi : fermé',
      'Dimanche : fermé',
    ]);
  });

  it('annonce la dernière réservation de chaque service quand elle est fixée', () => {
    const hours = formatOpeningHours({
      tue: {
        open: '12:00',
        close: '22:30',
        slots: [
          { open: '12:00', close: '14:30', lastBooking: '14:00' },
          { open: '19:00', close: '22:30', lastBooking: '21:30' },
        ],
      },
      fri: { open: '12:00', close: '23:00', lastBooking: '21:30' },
      sat: { open: '12:00', close: '22:00' },
    });
    expect(hours).toContain(
      'Mardi : 12:00–14:30 (dernière réservation à 14:00) puis 19:00–22:30 (dernière réservation à 21:30)',
    );
    expect(hours).toContain('Vendredi : 12:00–23:00 (dernière réservation à 21:30)');
    expect(hours).toContain('Samedi : 12:00–22:00\n');
  });

  it('lit aussi les formats longs et schema.org, comme le calcul des créneaux', () => {
    expect(formatOpeningHours({ sunday: { opens: '12:00', closes: '15:00' } })).toContain(
      'Dimanche : 12:00–15:00',
    );
    expect(
      formatOpeningHours([{ dayOfWeek: 'Monday', opens: '18:00', closes: '23:00' }]),
    ).toContain('Lundi : 18:00–23:00');
  });

  it('n’affirme aucun jour quand les horaires ne sont pas renseignés', () => {
    expect(formatOpeningHours({})).toContain('Horaires non renseignés');
    expect(formatOpeningHours({})).not.toContain('fermé');
  });

  it('calcule le jour et les horaires de la date réservée (appel 0d49230d)', () => {
    const hours = { tue: { open: '12:00', close: '22:00' } };
    expect(describeDate('2026-09-28', hours)).toEqual({
      date: '2026-09-28',
      weekday: 'lundi',
      hours: 'FERMÉ ce jour-là',
    });
    expect(describeDate('2026-09-29', hours)?.hours).toBe('ouvert 12:00–22:00');
    expect(describeDate('2026-09-29', {})?.hours).toBe('horaires non renseignés');

    const state = createStructuredTurnState();
    state.draft.date = '2026-09-28';
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'vous êtes ouvert à quelle heure',
        state,
        openingHours: hours,
      }),
    );
    expect(system.content).toContain(
      '"dateFacts":{"date":"2026-09-28","weekday":"lundi","hours":"FERMÉ ce jour-là"}',
    );
  });

  it('annonce les deux services dans le prompt et le calendrier', () => {
    const hours = {
      tue: {
        open: '12:00',
        close: '22:30',
        services: [
          { open: '12:00', close: '14:30' },
          { open: '19:00', close: '22:30' },
        ],
      },
    };
    expect(formatOpeningHours(hours)).toContain('Mardi : 12:00–14:30 puis 19:00–22:30');
    expect(describeDate('2026-09-29', hours)?.hours).toBe('ouvert 12:00–14:30 puis 19:00–22:30');
  });

  it('annonce les slots du nouvel onboarding dans le prompt vocal', () => {
    const hours = {
      thu: {
        open: '12:00',
        close: '22:30',
        slots: [
          { open: '12:00', close: '14:30' },
          { open: '19:00', close: '22:30' },
        ],
      },
    };

    expect(formatOpeningHours(hours)).toContain('Jeudi : 12:00–14:30 puis 19:00–22:30');
    expect(describeDate('2026-09-24', hours)?.hours).toBe('ouvert 12:00–14:30 puis 19:00–22:30');
  });

  it("interdit d'annoncer une disponibilité avant le nombre de personnes (appel c5d6b07d)", () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: "est-ce que c'est possible de venir à 18 heures",
        state: createStructuredTurnState(),
      }),
    );
    // Rejeu Qwen du 28/09 : « Oui, 18 heures c'est possible » dans 7 à 8 tirages sur 10
    // sans nombre de personnes ; 0 sur 10 avec cette consigne.
    expect(system.content).toContain('tant que draft.partySize vaut 0');
    // Principe, pas de formule à imiter : l'horaire est retenu sans être annoncé comme acquis.
    expect(system.content).toContain("Retiens l'horaire dans draft sans l'annoncer comme acquis");
    expect(system.content).not.toContain("« 18 heures, c'est noté »");
    // Une valeur contenue dans une question n'est retenue que si elle est dite clairement.
    expect(system.content).toContain("ses mots suffisent à savoir de quelle information il s'agit");
    // Groupe connu : lire la ligne de sa taille, refuser un horaire absent (1–2/10 → 9/10).
    expect(system.content).toContain('« 9-12 » contient 10');
  });

  it('met en données les lettres épelées du tour quand un nom est attendu (appel 8043662c)', () => {
    const stateAwaiting = (awaiting: 'customerName' | 'customerNameConfirmation' | 'open') => {
      const state = createStructuredTurnState();
      state.lastAwaiting = awaiting;
      return state;
    };
    const stateOf = (transcript: string, awaiting: Parameters<typeof stateAwaiting>[0]) =>
      (
        systemOf(
          buildStructuredTurnMessages({
            systemPrompt: 'Prompt',
            history: [],
            transcript,
            state: stateAwaiting(awaiting),
          }),
        ).content as string
      ).split('ÉTAT VÉRIFIÉ : ')[1];

    const verified = JSON.parse(stateOf('au nom de a 2 s a 2 m', 'customerName').split('\n')[0]);
    expect(verified.spelledName).toBe('ASSAMM');
    expect(verified.spelledLetters).toEqual([
      { letter: 'A', count: 1 },
      { letter: 'S', count: 2 },
      { letter: 'A', count: 1 },
      { letter: 'M', count: 2 },
    ]);
    expect(
      JSON.parse(stateOf('m a 2 s o n', 'customerNameConfirmation').split('\n')[0]).spelledLetters,
    ).toHaveLength(5);
    // Pas d'épellation dans la parole, ou un autre message attendu : rien n'est ajouté.
    expect(stateOf('oui c’est ça', 'customerNameConfirmation')).not.toContain('spelled');
    expect(stateOf('a 2 s a 2 m', 'open')).not.toContain('spelled');
  });

  it('donne au modèle des principes de conversation, pas des phrases (appel b686b241)', () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'je voudrais bien venir',
        state: createStructuredTurnState(),
        dayPart: '15 h, après-midi',
      }),
    );
    // Rejeu Qwen sur les tours réels du 29/09 (20 tirages) : phrase d'intention sans
    // information, attente 14/20 → 20/20 ; nom épelé au récapitulatif 5/20 → 0/20 ;
    // récapitulatif 23,7 → 17 mots ; redemande à vide (60 tirages) 52/60 → 26/60 ;
    // « bonne soirée » à 15 h (40 tirages) 20/40 → 4/40.
    expect(system.content).toContain("sans donner encore l'information que tu attends");
    expect(system.content).toContain('ne repose jamais à vide la question');
    expect(system.content).toContain('dis-le comme un nom, pas lettre par lettre');
    // Le moment de la journée est un fait, placé en dernier au plus près de la formulation.
    const moment = system.content.indexOf('MOMENT DE LA JOURNÉE');
    expect(moment).toBeGreaterThan(system.content.indexOf('ÉTAT VÉRIFIÉ'));
    expect(system.content).toContain('15 h, après-midi');
  });

  it('attend une correction annoncée et prend congé après la réservation (appel 8ae1e63e)', () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'demain à 14 heures non',
        state: createStructuredTurnState(),
      }),
    );
    // Rejeu Qwen sur les tours réels du 29/09 (18 h 39) : une valeur suivie d'un rejet
    // n'était jamais jugée inachevée (0/20) → 25/30 ; « salut » après « Bonne soirée »
    // rouvrait un accueil 13/20 → 0/20 (fin d'appel 7/20 → 20/20) ; témoins inchangés.
    expect(system.content).toContain('est une correction en cours');
    expect(system.content).toContain("N'agis pas sur la valeur rejetée");
    expect(system.content).toContain('sa façon de prendre congé, pas un nouvel appel');
    expect(system.content).toContain('action=end_call');
  });

  it("n'ajoute aucun moment de la journée quand il n'est pas fourni", () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'bonjour',
        state: createStructuredTurnState(),
      }),
    );
    expect(system.content).not.toContain('MOMENT DE LA JOURNÉE (heure locale');
  });

  it("calcule l'heure locale pleine et le moment de la journée dans le fuseau du restaurant", () => {
    const at = (iso: string) => dayPartInTimezone('Europe/Paris', new Date(iso));
    expect(at('2026-09-29T13:09:00Z')).toBe('15 h, après-midi');
    expect(at('2026-09-29T05:30:00Z')).toBe('7 h, matin');
    expect(at('2026-09-29T16:00:00Z')).toBe('18 h, soir');
    expect(at('2026-09-29T01:00:00Z')).toBe('3 h, nuit');
    // Une minute plus tard, le fait reste identique : la requête spéculative aussi.
    expect(at('2026-09-29T13:10:00Z')).toBe(at('2026-09-29T13:09:00Z'));
  });

  it('interdit de recopier une question restée sans réponse (appel c5d6b07d)', () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'et vous avez une terrasse',
        state: createStructuredTurnState(),
      }),
    );
    // Rejeu Qwen du 29/09, question à côté (« terrasse ») : 8/10 répétaient
    // « Vous voulez venir vers quelle heure ? » mot pour mot ; 2/10 avec cette consigne.
    expect(system.content).toContain('ne recopie jamais ta dernière phrase');
    expect(system.content).toContain("reprends-la plus brièvement et avec d'autres mots");
  });

  it('donne un calendrier calculé de 14 jours, jours fermés compris (appel 88921164)', () => {
    const hours = { tue: { open: '12:00', close: '22:00' } };
    const calendar = describeCalendar('2026-09-27', hours).split('\n');
    expect(calendar).toHaveLength(14);
    expect(calendar[0]).toBe("2026-09-27 dimanche (aujourd'hui) : FERMÉ ce jour-là");
    expect(calendar[1]).toBe('2026-09-28 lundi (demain) : FERMÉ ce jour-là');
    expect(calendar[2]).toBe('2026-09-29 mardi (après-demain) : ouvert 12:00–22:00');

    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'on serait ouvert demain',
        state: createStructuredTurnState(),
        openingHours: hours,
        today: '2026-09-27',
      }),
    );
    expect(system.content).toContain('CALENDRIER (calculé');
    expect(system.content).toContain('2026-09-28 lundi (demain) : FERMÉ ce jour-là');
  });

  it('devrait generer le prompt de base sans CRM ni prompt extra', () => {
    const prompt = buildSystemPrompt(baseCtx, new Date('2026-07-22T10:00:00Z'));

    expect(prompt).toContain("Tu es l'assistant vocal chaleureux de Chez Michel.");
    expect(prompt).toContain("L'accueil a déjà été prononcé");
    expect(prompt).toContain('Tu évites le ton administratif');
    expect(prompt).toContain('SITUATIONS (des principes');
    expect(prompt).toContain('Non, plutôt 21 h 15.');
    expect(prompt).toContain("Merci, c'est tout.");
    expect(prompt).toContain('mercredi 22 juillet 2026, fuseau Europe/Paris');
    expect(prompt).not.toContain('Au tout début de chaque appel');
    expect(prompt).toContain('Lundi : 12:00–14:30');
    expect(prompt).toContain('Dimanche : fermé');
    // Aucun outil n'est décrit dans la base : le tour structuré décrit lui-même ses actions.
    expect(prompt).not.toContain('OUTILS DISPONIBLES');
    expect(prompt).not.toContain('checkAvailability');
    expect(prompt.trim().endsWith('Dimanche : fermé')).toBe(true);
  });

  it('devrait inclure customerExtra quand fourni dans le contexte', () => {
    const customerExtra = "Le client s'appelle Jean-Pierre. C'est sa 5e visite. ⭐ Client VIP.";
    const prompt = buildSystemPrompt({
      ...baseCtx,
      customerExtra,
    });

    expect(prompt).toContain('Jean-Pierre');
    expect(prompt).toContain('5e visite');
    expect(prompt).toContain('⭐ Client VIP.');
    expect(prompt).toContain(customerExtra);
  });

  it('devrait inclure systemPromptExtra de la personnalité quand fourni', () => {
    const systemPromptExtra = 'Sois très jovial et plaisante sur les plats du jour.';
    const prompt = buildSystemPrompt({
      ...baseCtx,
      personality: {
        fillerStyle: 'CASUAL',
        systemPromptExtra,
      },
    });

    expect(prompt).toContain(systemPromptExtra);
    expect(prompt.trim().endsWith(systemPromptExtra)).toBe(true);
  });

  it('devrait inclure a la fois customerExtra et systemPromptExtra dans le bon ordre', () => {
    const customerExtra = "Le client s'appelle Alice.";
    const systemPromptExtra = "Parle avec l'accent marseillais.";
    const prompt = buildSystemPrompt({
      ...baseCtx,
      customerExtra,
      personality: {
        fillerStyle: 'CASUAL',
        systemPromptExtra,
      },
    });

    expect(prompt).toContain(customerExtra);
    expect(prompt).toContain(systemPromptExtra);

    const lines = prompt
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const secondLastLine = lines[lines.length - 2];

    expect(lastLine).toBe(systemPromptExtra);
    expect(secondLastLine).toBe(customerExtra);
  });

  it('reconnaît un client connu par principe, sans formule ni civilité imposées', () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      returningCustomerFirstName: 'Jean',
    });

    expect(prompt).toContain('CLIENT CONNU');
    expect(prompt).toContain('prénom Jean');
    expect(prompt).toContain('ni de formule toute faite');
    expect(prompt).toContain('jamais en majuscules');
    expect(prompt).toContain('ni Monsieur ni Madame');
    expect(prompt).not.toContain('content de vous revoir');
  });

  it("n'ajoute aucune reconnaissance pour un appelant inconnu", () => {
    const prompt = buildSystemPrompt({ ...baseCtx, returningCustomerFirstName: '' });
    expect(prompt).not.toContain('CLIENT CONNU');
  });
});
describe('phrases à dire : des principes, pas des formules', () => {
  const hours = { tue: { open: '12:00', close: '22:00' } };
  const base = buildSystemPrompt({ name: 'Chez Test', openingHours: hours });
  const system = systemOf(
    buildStructuredTurnMessages({
      systemPrompt: base,
      history: [],
      transcript: 'bonjour',
      state: createStructuredTurnState(),
    }),
  );
  const prompt = String(system.content);

  it("ne donne plus de phrase de l'agent à imiter ni de formule d'accusé de réception nommée", () => {
    for (const formula of [
      'Oui, bien sûr. Vous serez combien ?',
      'Avec plaisir. Bonne soirée.',
      "D'accord, je garde",
      "Je n'ai aucun autre créneau vérifié",
      'Et vers quelle heure ?',
      'Alors, quelle heure vous arrange ?',
      'Donc, vous serez combien ?',
      'Vous voulez venir vers quelle heure ?',
      '16 heures, parfait',
      'lundi 28 septembre',
    ]) {
      expect(prompt).not.toContain(formula);
    }
  });

  it("garde les interdictions nommées : une liste de formules interdites oriente mieux qu'un principe nu", () => {
    // Mesuré le 01/10 : converties en principe seul, « c'est noté » passe de 4 à 10 ouvertures sur ~480 et un
    // « C'est possible » interdit apparaît 2 fois sur 12 (0/12 avant). Ce sont des interdictions, pas des phrases à imiter.
    expect(prompt).toContain("« Parfait », « Très bien », « C'est noté », « Avec plaisir »");
    expect(prompt).toContain('pas de « Parfait » ou « Très bien » systématique en ouverture');
    expect(prompt).toContain(
      "ne dis jamais qu'un horaire est possible, libre ou que « ça marche »",
    );
    expect(prompt).toContain("ne dis pas « c'est noté » pour cet horaire");
  });

  it("une information retenue n'a pas à être redite : ni répétition interdite en bloc, ni confirmation à chaque tour", () => {
    expect(prompt).toContain("Une information retenue n'a pas besoin d'être redite à voix haute");
    expect(prompt).toContain(
      'Tu ne demandes pas de confirmer cette date, cette heure ou ce nombre',
    );
    expect(prompt).not.toContain("Tu ne répètes pas ce que l'appelant vient de dire");
    expect(prompt).not.toContain('fais-lui confirmer cette valeur');
    expect(prompt).toContain('reste un réflexe, même variée');
    expect(prompt).toContain('ni aucune autre formule qui revient à chaque tour');
  });

  it("garde des exemples d'interprétation de l'entrée, avec des valeurs absentes du banc", () => {
    // Ce que dit l'appelant : on garde, pour apprendre à le comprendre.
    for (const heard of [
      '« allô ? »',
      '« oui »',
      '« merci »',
      '« attendez »',
      '« il reste de la place ? »',
    ]) {
      expect(prompt).toContain(heard);
    }
    // « six » valait la valeur 6 du banc, « K I F » les lettres de AKKIF : remplacés.
    expect(prompt).toContain('« trois »');
    expect(prompt).not.toContain('« six »');
    expect(prompt).not.toContain('K I F');
  });
});

describe('buildSystemPrompt : base sans outil', () => {
  const hours = { tue: { open: '12:00', close: '22:00' } };
  const base = { name: 'Chez Test', openingHours: hours, giftCardMinimumAmount: 25 };
  const prompt = buildSystemPrompt(base);

  it('ne reçoit aucun outil : le tour structuré décrit lui-même ses actions', () => {
    for (const name of [
      'RÈGLES DU MODE À OUTILS',
      'OUTILS DISPONIBLES',
      'checkAvailability',
      'createReservation',
      'cancelReservation',
      'reportDelay',
      'takeMessage',
      'handoffToManager',
      'purchaseGiftCard',
      'recommendGiftCardAmount',
      'lien de paiement',
    ]) {
      expect(prompt).not.toContain(name);
    }
    for (const common of ['DATE COURANTE', 'COMPORTEMENT :', 'HORAIRES', 'Mardi : 12:00–22:00']) {
      expect(prompt).toContain(common);
    }
  });

  it('ne contient pas la contradiction « Parfait, donc… »', () => {
    expect(prompt).not.toContain('« Parfait, donc… »');
  });

  it('la personnalisation du restaurant reste en fin de prompt', () => {
    const custom = {
      ...base,
      customerExtra: 'EXTRA-CLIENT',
      personality: { systemPromptExtra: 'EXTRA-PERSO' },
    };
    expect(buildSystemPrompt(custom).trimEnd().endsWith('EXTRA-PERSO')).toBe(true);
  });

  it("les consignes du tour structuré disent ce qu'il ne peut pas faire", () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: prompt,
        history: [],
        transcript: 'bonjour',
        state: createStructuredTurnState(),
      }),
    );
    expect(system.content).not.toContain('prioritaire sur la section OUTILS');
    expect(system.content).toContain(
      'Tu ne peux ni annuler une réservation, ni signaler un retard, ni vendre une carte cadeau',
    );
  });
});

describe('genre de la voix', () => {
  const ctx = { name: 'Chez Michel', openingHours: {} };
  const now = new Date('2026-10-01T12:00:00Z');

  it('dit au modèle le genre de sa voix, sans lui imposer de mots, quand il est connu', () => {
    const masculine = buildSystemPrompt({ ...ctx, voiceGender: 'masculine' }, now);
    expect(masculine).toContain('Ta voix est masculine');
    expect(masculine).toContain('s’accordent à ce genre'.replace('’', "'"));
    expect(buildSystemPrompt({ ...ctx, voiceGender: 'feminine' }, now)).toContain(
      'Ta voix est féminine',
    );
  });

  it('ne dit rien du genre quand il est inconnu : le prompt reste celui d’avant', () => {
    expect(buildSystemPrompt(ctx, now)).not.toContain('Ta voix est');
    expect(buildSystemPrompt({ ...ctx }, now)).not.toContain('Ta voix est');
  });

  it('vaut aussi pour le tour structuré (base commune)', () => {
    expect(buildSystemPrompt({ ...ctx, voiceGender: 'masculine' }, now)).toContain(
      'Ta voix est masculine',
    );
  });

  it('vient du réglage de la voix par défaut, et jamais d’une voix propre au restaurant (genre inconnu)', () => {
    expect(agentVoiceGender(null, { VOICE_GENDER: 'masculine' })).toBe('masculine');
    expect(agentVoiceGender({}, { VOICE_GENDER: 'Feminine ' })).toBe('feminine');
    expect(
      agentVoiceGender({ voiceIdCa: 'voix-du-restaurant' }, { VOICE_GENDER: 'masculine' }),
    ).toBeUndefined();
    expect(agentVoiceGender(null, {})).toBeUndefined();
    expect(agentVoiceGender(null, { VOICE_GENDER: 'autre' })).toBeUndefined();
  });

  it('lit encore l’ancien nom du réglage, mais le nouveau l’emporte, même quand il est vide', () => {
    expect(agentVoiceGender(null, { CARTESIA_VOICE_GENDER: 'feminine' })).toBe('feminine');
    expect(
      agentVoiceGender(null, { VOICE_GENDER: 'masculine', CARTESIA_VOICE_GENDER: 'feminine' }),
    ).toBe('masculine');
    expect(agentVoiceGender(null, { VOICE_GENDER: '', CARTESIA_VOICE_GENDER: 'feminine' })).toBe(
      'feminine',
    );
  });
});

describe('tour structuré : informations déjà données', () => {
  it('retient le jour, l’heure et le nombre dits dans une question, et ne les redemande pas', () => {
    const system = systemOf(
      buildStructuredTurnMessages({
        systemPrompt: 'Prompt',
        history: [],
        transcript: 'vous êtes ouvert demain',
        state: createStructuredTurnState(),
        openingHours: {} as never,
      }),
    );
    expect(system.content).toContain(
      'même dans une question sur les horaires ou les disponibilités',
    );
    expect(system.content).toContain(
      "sauf s'ils sont ambiguës, contredits par ce que l'appelant vient de dire, ou si le créneau n'est plus disponible",
    );
  });
});
