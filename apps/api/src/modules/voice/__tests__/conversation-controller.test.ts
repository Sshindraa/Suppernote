import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeterministicTurnResponse,
  buildDeterministicTurnPlan,
  buildAvailabilityFollowupPlan,
  buildAvailabilityFollowupResponse,
  buildAnswerChoicePlan,
  openingHourTimes,
  extractDayPeriod,
  buildHumanFallbackOffer,
  classifyVoiceSpeechAct,
  classifyVoiceSpeechActInContext,
  createConversationState,
  getReadyAvailabilityRequest,
  guardDialogueReprompt,
  buildReservationProgressPlan,
  buildReservationProgressResponse,
  buildPendingQuestionResponse,
  extractPlainCustomerName,
  parseSpelledNameTranscript,
  parseSpelledNameTranscriptDetailed,
  recordAssistantReply as applyAssistantReplyPolicyDecision,
  recordAssistantReplyWithPolicy,
  recordAssistantReplyFromLlmTextFallback as recordAssistantReply,
  recordUserTurn,
  resetDialogueStall,
  pendingQuestionFrom,
} from '../stream/conversation-controller';
import {
  buildAvailabilityReplyPlan,
  buildAvailabilityReply,
  buildLlmFailurePlan,
  extractConversationSlots,
  getActivePendingInteraction,
} from '../stream/conversation-state';
import { decideAssistantInteractionPolicy } from '../stream/turn-policy';
import type { CallSession } from '../stream/types';

function makeSession(): CallSession {
  return { conversation: createConversationState() } as CallSession;
}

describe('classifyVoiceSpeechAct', () => {
  it.each([
    ['Allô ?', 'liveness'],
    ['D’accord.', 'backchannel'],
    ['Merci, c’est tout.', 'closing'],
    ['Non non merci au revoir.', 'closing'],
    ['Non, plutôt 20 h 30.', 'correction'],
    ['À 19 h 30, non plutôt 20 h 30.', 'correction'],
    ['Je voudrais réserver demain.', 'content'],
  ] as const)('classifie « %s » comme %s', (transcript, expected) => {
    expect(classifyVoiceSpeechAct(transcript)).toBe(expected);
  });

  it('garde le sens de « c’est bon » quand une confirmation est attendue', () => {
    const session = makeSession();
    recordAssistantReply(session, 'J’ai une table pour quatre personnes. Vous me confirmez ?');

    expect(session.conversation.pendingQuestion).toBe('confirmation');
    expect(classifyVoiceSpeechAct('C’est bon')).toBe('closing');
    expect(classifyVoiceSpeechActInContext(session, 'C’est bon')).toBe('content');
  });

  it('reconnaît les attentes de confirmation, de créneau et de téléphone', () => {
    expect(pendingQuestionFrom('Vous me confirmez ?')).toBe('confirmation');
    expect(pendingQuestionFrom('Ça vous va pour samedi ?')).toBe('confirmation');
    // Récapitulatif réel du LLM, appel du 24/09.
    expect(
      pendingQuestionFrom(
        'Je confirme : réservation pour 6 personnes demain, vendredi 25 septembre, à 22 h 30, au nom de Akif Adebayor. C’est bon ?',
      ),
    ).toBe('confirmation');
    expect(pendingQuestionFrom('Je peux la réserver ?')).toBe('confirmation');
    expect(pendingQuestionFrom('Quel horaire vous conviendrait ?')).toBe('timeChoice');
    expect(pendingQuestionFrom('Quel créneau préférez-vous ?')).toBe('timeChoice');
    expect(pendingQuestionFrom('Quel numéro puis-je utiliser ?')).toBe('customerPhone');
  });

  it('type une confirmation de couverts séparément de la confirmation de réservation', () => {
    const session = makeSession();
    recordAssistantReply(session, 'Pour être sûr, on est bien à quatre, c’est ça ?');

    expect(session.conversation.pendingQuestion).toBe('partySizeConfirmation');
    expect(getActivePendingInteraction(session)).toMatchObject({
      kind: 'partySizeConfirmation',
      candidatePartySize: 4,
      status: 'active',
    });
  });

  it('recordAssistantReply applique la policy reçue sans inférer une question depuis le texte', () => {
    const session = makeSession();
    const decision = decideAssistantInteractionPolicy(
      { source: 'explicit', operation: 'cancel' },
      null,
    );

    expect(decision.status).toBe('accepted');
    if (decision.status === 'accepted') {
      applyAssistantReplyPolicyDecision(
        session,
        'Pour combien de personnes souhaitez-vous réserver ?',
        decision,
      );
    }

    expect(session.conversation.pendingQuestion).toBeNull();
    expect(session.conversation.pendingInteractions).toEqual([]);
  });

  it('une proposition explicite invalide échoue sans déduire le type depuis la phrase', () => {
    const session = makeSession();
    recordAssistantReply(
      session,
      'Je peux prendre un message pour le gérant. Voulez-vous que je le fasse ?',
    );

    recordAssistantReplyWithPolicy(session, 'Pour combien de personnes souhaitez-vous réserver ?', {
      source: 'explicit',
      operation: 'activate',
    });

    expect(getActivePendingInteraction(session)).toBeNull();
    expect(session.conversation.pendingQuestion).toBeNull();
  });
});

describe('conversation state', () => {
  it.each(['quatre', 'on ferait quatre', 'on serait quatre', 'on vient à quatre'])(
    'comprend « %s » quand la question active demande le nombre de couverts',
    (transcript) => {
      const session = makeSession();
      recordAssistantReply(session, 'Pour combien de personnes souhaitez-vous réserver ?');

      recordUserTurn(session, transcript, 'content', new Date('2026-09-22T10:00:00Z'));

      expect(session.conversation.slots.partySize).toBe(4);
      expect(getActivePendingInteraction(session)).toBeNull();
      expect(session.conversation.pendingInteractions.at(-1)?.status).toBe('resolved');
    },
  );

  it.each([
    'On sera une petite tablée, disons cinq',
    'On est un groupe, cinq je pense',
    'Nous serons une famille nombreuse',
  ])('ne lit pas l’article de « %s » comme un couvert', (transcript) => {
    const session = makeSession();
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, transcript, 'content');

    expect(session.conversation.slots.partySize).not.toBe(1);
    expect([5, undefined]).toContain(session.conversation.slots.partySize);
  });

  it.each(['On sera un', 'nous serons une personne', 'on sera un seul', 'on sera une.'])(
    'garde « %s » à un couvert',
    (transcript) => {
      const session = makeSession();
      recordAssistantReply(session, 'Vous serez combien ?');

      recordUserTurn(session, transcript, 'content');

      expect(session.conversation.slots.partySize).toBe(1);
    },
  );

  it('ne contourne pas la limite de sept couverts du parcours vocal', () => {
    const session = makeSession();
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'on serait huit', 'content');

    expect(session.conversation.slots.partySize).toBeUndefined();
    expect(getActivePendingInteraction(session)?.kind).toBe('partySize');
  });

  it('applique un oui à la confirmation des couverts et jamais à celle de la réservation', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'On est bien à quatre, c’est ça ?');

    recordUserTurn(session, 'Oui', 'content');

    expect(session.conversation.slots.partySize).toBe(4);
    expect(session.conversation.pendingQuestion).toBeNull();
    expect(session.conversation.pendingReservationConfirmationKey).toBeNull();
    expect(session.conversation.pendingInteractions.at(-1)?.status).toBe('resolved');
  });

  it('mémorise une intention et la question métier en attente', () => {
    const session = makeSession();
    recordUserTurn(session, 'Je voudrais réserver une table', 'content');
    recordAssistantReply(session, 'Très bien. Quel est votre nom pour la réservation ?');

    expect(session.conversation.intent).toBe('reservation');
    expect(session.conversation.pendingQuestion).toBe('customerName');
    expect(session.conversation.lastAssistantQuestion).toBe(
      'Quel est votre nom pour la réservation ?',
    );
  });

  it('reconnaît aussi la formulation courte « à quel nom je réserve ? »', () => {
    const session = makeSession();
    recordAssistantReply(session, 'Parfait. À quel nom je réserve ?');

    expect(session.conversation.pendingQuestion).toBe('customerName');
  });

  it('retient un nom simple déjà donné pour le transmettre au prochain tour', () => {
    const session = makeSession();
    recordAssistantReply(session, 'À quel nom je réserve ?');
    recordUserTurn(session, 'Akif', 'content');

    expect(session.conversation.slots.customerName).toBe('Akif');
    expect(extractPlainCustomerName('Au nom de Akif')).toBe('Akif');
    expect(extractPlainCustomerName('A K I F', true)).toBeNull();
  });

  it('ne répète pas mécaniquement la question de nom après un acquiescement', () => {
    const session = makeSession();
    recordAssistantReply(session, 'Parfait. À quel nom je réserve ?');

    expect(buildPendingQuestionResponse(session, 'Oui')).toBe("C'est à quel nom ?");
  });

  it('ne transforme pas un oui de confirmation en répétition de la question', () => {
    const session = makeSession();
    recordAssistantReply(session, 'J’ai une table pour quatre personnes. Vous me confirmez ?');

    expect(buildDeterministicTurnResponse(session, 'content', 'Oui')).toBeNull();
  });

  it('conserve les lettres d’une épellation claire avec le STT courant', () => {
    expect(parseSpelledNameTranscript('Au nom de K I F')).toEqual({
      value: 'KIF',
      confident: true,
    });
  });

  it('refuse de deviner quand Scribe ajoute du bruit dans une épellation', () => {
    expect(parseSpelledNameTranscript('Un nom de actif a de k i f')).toEqual({
      value: 'ADKIF',
      confident: false,
    });
  });

  it('reconnaît la variante Scribe « en nombre de actifs » dans une question de nom', () => {
    expect(parseSpelledNameTranscript('En nombre de actifs, a de k i f')).toEqual({
      value: 'ADKIF',
      confident: true,
    });
  });

  it('ignore le préfixe de correction avant une nouvelle épellation', () => {
    expect(parseSpelledNameTranscript('Non, a d k i f')).toEqual({
      value: 'ADKIF',
      confident: true,
    });
  });

  it.each([
    ['A K I F', 'AKIF'],
    ['a ka i effe', 'AKIF'],
    ['K-I-F', 'KIF'],
    ['Je vous épelle : L I', 'LI'],
    ['A comme Anatole, K comme Karim, I comme Isabelle, F comme François', 'AKIF'],
    ['A comme Anatole K I F', 'AKIF'],
    ['A deux L A N', 'ALLAN'],
    ['a k 2 k i f', 'AKKIF'],
    ['a k f a 2 k i f', 'AKKIF'],
    ['dupont d u p o n t', 'DUPONT'],
    ['a k deux k i f', 'AKKIF'],
    ['a k double k i f', 'AKKIF'],
    ['a k alors deux k euh i f', 'AKKIF'],
    ['double L', 'LL'],
    ['double vé i grec', 'WY'],
    ['K tiret I F', 'K-IF'],
    ['K trait d’union I F', 'K-IF'],
  ])('parse %s sans corriger le transcript en %s', (transcript, expected) => {
    expect(parseSpelledNameTranscript(transcript)).toMatchObject({
      value: expected,
      confident: true,
    });
  });

  it('conserve les positions ambiguës dans le candidat détaillé', () => {
    const parsed = parseSpelledNameTranscriptDetailed('Un nom de actif a de k i f');

    expect(parsed).toMatchObject({
      value: 'ADKIF',
      partialCandidate: '?ADKIF',
      confident: false,
      ambiguousPositions: [0],
    });
    expect(parsed?.tokens[0]).toMatchObject({ kind: 'ambiguous', value: null, position: 0 });
  });

  it('ne traite pas les particules et noms composés ordinaires comme une épellation', () => {
    expect(parseSpelledNameTranscript('Jean de La Fontaine')).toBeNull();
    expect(parseSpelledNameTranscript('Anne-Marie')).toBeNull();
    expect(parseSpelledNameTranscript('de')).toBeNull();
  });

  it('reprend une question après un acquiescement sans appeler le LLM', () => {
    const session = makeSession();
    recordAssistantReply(session, 'Pour combien de personnes souhaitez-vous réserver ?');

    expect(buildDeterministicTurnResponse(session, 'backchannel')).toBe(
      "D'accord. Pour combien de personnes souhaitez-vous réserver ?",
    );
  });

  it('confie la formulation de clôture au LLM sans rouvrir le dialogue', () => {
    const session = makeSession();

    recordUserTurn(session, 'Non non merci au revoir', 'closing');
    expect(buildDeterministicTurnResponse(session, 'closing')).toBeNull();
    expect(session.conversation.closing).toBe(true);
  });

  it('propose un repli humain exécutable après deux incompréhensions consécutives', () => {
    const session = makeSession();
    recordAssistantReply(session, "Désolé, je n'ai pas bien compris. Pouvez-vous répéter ?");
    recordAssistantReply(session, "Désolé, je n'ai pas bien compris. Pouvez-vous répéter ?");

    const offer = buildDeterministicTurnResponse(session, 'content');
    expect(offer).toBe(
      'Je peux prendre un message pour le gérant, il vous rappellera. Voulez-vous que je le fasse ?',
    );
    // Aucune phrase ne doit annoncer un transfert qui n'aurait pas lieu.
    expect(offer).not.toContain('Je vais vous passer le gérant');
    recordAssistantReply(session, offer!);
    expect(session.conversation.humanFallbackOffered).toBe(true);
    expect(pendingQuestionFrom(offer!)).toBe('humanFallback');
  });

  it('réinitialise le compteur dès qu’une réponse métier a été comprise', () => {
    const session = makeSession();
    recordAssistantReply(session, "Désolé, je n'ai pas bien compris. Pouvez-vous répéter ?");
    recordAssistantReply(session, 'Très bien. Vous serez combien ?');

    expect(session.conversation.misunderstandingCount).toBe(0);
    expect(buildDeterministicTurnResponse(session, 'content')).toBeNull();
  });

  it('reformule puis propose un repli humain quand la même question reste sans réponse', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    recordUserTurn(
      session,
      'Je voudrais réserver demain soir',
      'content',
      new Date('2026-09-04T10:00:00Z'),
    );

    expect(buildReservationProgressResponse(session, 'Euh alors voila')).toBe(
      'Samedi 5, très bien. Vous serez combien ?',
    );

    recordUserTurn(session, 'Euh alors voila', 'content');
    expect(buildReservationProgressResponse(session, 'Euh alors voila')).toBe(
      'Je note combien de personnes ? Dites-moi simplement un nombre, par exemple « quatre ».',
    );

    recordUserTurn(session, 'Euh alors voila', 'content');
    const offer = buildReservationProgressResponse(session, 'Euh alors voila');
    expect(offer).toBe(
      'Je peux prendre un message pour le gérant, il vous rappellera. Voulez-vous que je le fasse ?',
    );
    recordAssistantReply(session, offer!);
    expect(session.conversation.humanFallbackOffered).toBe(true);
    expect(pendingQuestionFrom(offer!)).toBe('humanFallback');
  });

  it('repart de la formulation normale dès qu’une information progresse', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    recordUserTurn(
      session,
      'Je voudrais réserver demain soir',
      'content',
      new Date('2026-09-04T10:00:00Z'),
    );

    expect(buildReservationProgressResponse(session, 'Euh alors voila')).toBe(
      'Samedi 5, très bien. Vous serez combien ?',
    );
    expect(buildReservationProgressResponse(session, 'Euh alors voila')).toContain(
      'Je note combien de personnes',
    );

    recordUserTurn(session, 'Pour quatre personnes', 'content');
    expect(buildReservationProgressResponse(session, 'Pour quatre personnes')).toBe(
      'Quatre personnes, très bien. Vous voulez venir vers quelle heure ?',
    );
  });

  it('déclare le champ attendu quand il émet une relance déterministe', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    session.conversation.slots.date = '2026-09-24';

    const plan = buildReservationProgressPlan(session);

    expect(plan?.reply).toBe('Vous serez combien ?');
    expect(plan?.proposal).toMatchObject({
      source: 'explicit',
      operation: 'activate',
      interaction: { kind: 'partySize' },
    });
    recordAssistantReplyWithPolicy(session, plan!.reply, plan!.proposal);
    expect(getActivePendingInteraction(session)?.kind).toBe('partySize');
  });

  it('lie une relance de backchannel au type de la question déjà en attente', () => {
    const session = makeSession();
    session.conversation.pendingQuestion = 'partySize';
    session.conversation.lastAssistantQuestion =
      'Pour combien de personnes souhaitez-vous réserver ?';

    const plan = buildDeterministicTurnPlan(session, 'backchannel');

    expect(plan?.proposal).toMatchObject({
      source: 'explicit',
      interaction: { kind: 'partySize' },
    });
  });

  it('annule une ancienne offre quand l’assistant pose une nouvelle question', () => {
    const session = makeSession();
    session.managerPhone = '+33600000000';
    recordAssistantReply(
      session,
      'Je peux vous passer le gérant, ou prendre un message pour lui. Que préférez-vous ?',
    );

    recordAssistantReply(session, 'Désolé, j’ai perdu le fil. On est bien à quatre ?');

    expect(session.conversation.humanFallbackOffered).toBe(false);
    expect(session.conversation.humanFallbackMode).toBeNull();
    expect(session.conversation.pendingQuestion).not.toBe('humanFallback');
  });

  it('ne répète pas une proposition de repli humain déjà en attente', () => {
    const session = makeSession();
    recordAssistantReply(
      session,
      'Je peux prendre un message pour le gérant, il vous rappellera. Voulez-vous que je le fasse ?',
    );

    expect(session.conversation.pendingQuestion).toBe('humanFallback');
    expect(buildDeterministicTurnResponse(session, 'content', 'Euh alors voila')).toBeNull();
    expect(buildDeterministicTurnResponse(session, 'backchannel')).toBeNull();
  });

  it('rend l’offre de repli exécutable quand la disponibilité ne renvoie rien', () => {
    const session = makeSession();
    session.conversation.lastAvailabilityResult = {
      key: '2026-07-23:20:00:2',
      date: '2026-07-23',
      time: '20:00',
      partySize: 2,
      slots: [],
    };

    const reply = buildAvailabilityFollowupResponse(session, 'Du coup, vous proposez quoi ?');
    recordAssistantReply(session, reply!);
    expect(session.conversation.pendingQuestion).toBe('humanFallback');
  });

  it('garde la première relance intacte et n’escalade qu’après répétition', () => {
    const session = makeSession();
    session.conversation.pendingQuestion = 'partySize';
    const primary = 'Pour combien de personnes dois-je réserver ?';

    expect(guardDialogueReprompt(session, 'partySize', primary)).toBe(primary);
    expect(session.conversation.stalledTurns).toBe(1);
    expect(guardDialogueReprompt(session, 'partySize', primary)).toContain('Je note combien');
    expect(session.conversation.stalledTurns).toBe(2);

    resetDialogueStall(session);
    expect(guardDialogueReprompt(session, 'partySize', primary)).toBe(primary);
    expect(session.conversation.stalledTurns).toBe(1);
  });

  it('propose un transfert réel seulement quand une ligne gérant est configurée', () => {
    const withoutLine = makeSession();
    const messageOnlyOffer = buildHumanFallbackOffer(withoutLine);
    expect(messageOnlyOffer).not.toContain('passer le gérant');
    expect(withoutLine.conversation.humanFallbackOffered).toBe(false);
    recordAssistantReply(withoutLine, messageOnlyOffer);
    expect(withoutLine.conversation.humanFallbackMode).toBe('message');

    const withLine = makeSession();
    withLine.managerPhone = '+33600000000';
    const transferOffer = buildHumanFallbackOffer(withLine);
    expect(transferOffer).toContain('passer le gérant');
    expect(pendingQuestionFrom(transferOffer)).toBe('humanFallback');
    recordAssistantReply(withLine, transferOffer);
    expect(withLine.conversation.humanFallbackMode).toBe('choice');
  });

  it('n’interprète pas une question comme la réponse à un champ manquant', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    session.conversation.slots = { date: '2026-09-23', partySize: 4 };

    expect(
      buildReservationProgressResponse(session, 'Est-ce que vous avez une terrasse ?'),
    ).toBeNull();
    expect(session.conversation.stalledTurns).toBe(0);
  });

  it('extrait les slots français et rend la disponibilité prête au même tour', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    recordUserTurn(
      session,
      'Je voudrais réserver demain à 20 h pour deux personnes',
      'content',
      new Date('2026-07-22T10:00:00Z'),
    );

    expect(session.conversation.slots).toEqual({
      date: '2026-07-23',
      time: '20:00',
      partySize: 2,
    });
    expect(getReadyAvailabilityRequest(session)).toEqual({
      date: '2026-07-23',
      time: '20:00',
      partySize: 2,
      key: '2026-07-23:20:00:2',
    });
  });

  it('garde la collecte de réservation sur une seule question à la fois', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    recordUserTurn(
      session,
      'Je voudrais réserver demain soir',
      'content',
      new Date('2026-09-04T10:00:00Z'),
    );
    expect(buildReservationProgressResponse(session)).toBe(
      'Samedi 5, très bien. Vous serez combien ?',
    );

    recordUserTurn(session, 'Pour quatre personnes', 'content');
    expect(buildReservationProgressResponse(session, 'Pour quatre personnes')).toBe(
      'Quatre personnes, très bien. Vous voulez venir vers quelle heure ?',
    );
  });

  it('convertit les heures et ne propose que deux alternatives', () => {
    expect(
      buildAvailabilityReply({ date: '2026-07-23', time: '20:00', partySize: 2 }, [
        '19:30',
        '20:30',
        '21:00',
      ]),
    ).toBe("Alors 20 h c'est complet, par contre j'ai 19 h 30 ou 20 h 30. Ça vous irait ?");
  });

  it('propose de regarder un autre jour quand aucun créneau vérifié n’existe', () => {
    expect(buildAvailabilityReply({ date: '2026-07-23', time: '20:00', partySize: 4 }, [])).toBe(
      'Ah, malheureusement on est complets ce jour-là pour 4 personnes. Vous voulez que je regarde un autre jour ?',
    );
  });

  it('déclare le type d’interaction à partir du résultat de disponibilité', () => {
    const session = makeSession();
    const request = { date: '2026-09-24', time: '20:00', partySize: 2 };

    expect(buildAvailabilityReplyPlan(session, request, ['20:00']).proposal).toMatchObject({
      interaction: { kind: 'customerName' },
    });
    expect(buildAvailabilityReplyPlan(session, request, ['19:30']).proposal).toMatchObject({
      interaction: { kind: 'timeChoice' },
    });
    expect(buildAvailabilityReplyPlan(session, request, []).proposal).toMatchObject({
      interaction: { kind: 'date' },
    });
  });

  it('déclare un repli réellement disponible après une recherche vide', () => {
    const session = makeSession();
    session.conversation.lastAvailabilityResult = {
      key: '2026-07-23:20:00:2',
      date: '2026-07-23',
      time: '20:00',
      partySize: 2,
      slots: [],
    };

    const plan = buildAvailabilityFollowupPlan(session, 'Du coup, vous proposez quoi ?');
    expect(plan?.reply).toBe(
      "Je n'ai aucun autre créneau vérifié ce jour-là. Je peux prendre un message pour le gérant, il vous rappellera. Voulez-vous que je le fasse ?",
    );
    expect(plan?.proposal).toMatchObject({
      source: 'explicit',
      interaction: { kind: 'humanFallback', fallbackMode: 'message' },
    });
    recordAssistantReplyWithPolicy(session, plan!.reply, plan!.proposal);
    expect(getActivePendingInteraction(session)?.fallbackMode).toBe('message');

    const withManagerLine = makeSession();
    withManagerLine.managerPhone = '+33600000000';
    withManagerLine.conversation.lastAvailabilityResult =
      session.conversation.lastAvailabilityResult;
    const managerPlan = buildAvailabilityFollowupPlan(
      withManagerLine,
      'Du coup, vous proposez quoi ?',
    );
    expect(managerPlan?.proposal).toMatchObject({
      interaction: { kind: 'humanFallback', fallbackMode: 'choice' },
    });
  });

  it('demande de préciser le nombre après une transcription ambiguë', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Vous serez combien ?');

    expect(buildDeterministicTurnResponse(session, 'content', "Je s'en sera pas de personne")).toBe(
      "Je n'ai pas bien compris le nombre de personnes. Vous serez combien ?",
    );
  });

  it('calcule les dates relatives dans le fuseau du restaurant', () => {
    expect(
      extractConversationSlots(
        'Demain à 20 heures',
        'Europe/Paris',
        new Date('2026-07-22T22:30:00Z'),
      ),
    ).toMatchObject({ date: '2026-07-24', time: '20:00' });
  });

  it('calcule après-demain comme deux jours après la date locale', () => {
    expect(
      extractConversationSlots(
        'Après-demain à 20 heures',
        'Europe/Paris',
        new Date('2026-07-22T10:00:00Z'),
      ),
    ).toMatchObject({ date: '2026-07-24', time: '20:00' });
  });

  it('conserve uniquement la nouvelle valeur après une correction', () => {
    expect(extractConversationSlots('À 19 h 30, non plutôt 20 h 30', 'Europe/Paris')).toMatchObject(
      {
        time: '20:30',
      },
    );
  });

  it('invalide la disponibilité précédente quand le brouillon est corrigé', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    session.conversation.slots = {
      date: '2026-07-23',
      time: '19:30',
      partySize: 4,
    };
    session.conversation.lastAvailabilityCheck = '2026-07-23:19:30:4';
    session.conversation.lastAvailabilityResult = {
      key: '2026-07-23:19:30:4',
      date: '2026-07-23',
      time: '19:30',
      partySize: 4,
      slots: ['19:30'],
    };

    recordUserTurn(session, 'À 19 h 30, non plutôt 20 h 30', 'correction');

    expect(session.conversation.slots.time).toBe('20:30');
    expect(session.conversation.lastAvailabilityCheck).toBeNull();
    expect(session.conversation.lastAvailabilityResult).toBeNull();
  });

  it('conserve une date ISO explicite', () => {
    expect(extractConversationSlots('Le 2026-08-01 à 19:30', 'Europe/Paris')).toMatchObject({
      date: '2026-08-01',
      time: '19:30',
    });
  });

  it('reconnaît une heure transcrite sans séparateur (« 19 30 »)', () => {
    expect(
      extractConversationSlots('Demain à 19 30 pour deux personnes', 'Europe/Paris'),
    ).toMatchObject({
      time: '19:30',
      partySize: 2,
    });
  });

  it('reconnaît une heure transcrite en toutes lettres (« vingt heures »)', () => {
    expect(
      extractConversationSlots(
        'Demain soir, vers vingt heures, pour quatre personnes',
        'Europe/Paris',
      ),
    ).toMatchObject({ time: '20:00', partySize: 4 });
  });

  it('reconnaît les minutes et les heures composées en toutes lettres', () => {
    expect(
      extractConversationSlots('Vendredi à vingt et une heures trente', 'Europe/Paris'),
    ).toMatchObject({
      time: '21:30',
    });
    expect(
      extractConversationSlots('Samedi à dix-neuf heures et quart', 'Europe/Paris'),
    ).toMatchObject({
      time: '19:15',
    });
  });

  it('reconnaît « à midi » comme une heure vérifiable', () => {
    expect(
      extractConversationSlots(
        'Demain soir, pour quatre personnes. Est-ce possible à midi ?',
        'Europe/Paris',
      ),
    ).toMatchObject({
      date: expect.any(String),
      time: '12:00',
      partySize: 4,
    });
  });

  it('ne confond pas le nombre de personnes avec une heure', () => {
    expect(extractConversationSlots('Demain pour 2 personnes', 'Europe/Paris')).not.toHaveProperty(
      'time',
    );
  });

  it('résout le prochain jour de semaine dans le fuseau du restaurant', () => {
    expect(
      extractConversationSlots(
        'Vendredi à 19 heures',
        'Europe/Paris',
        new Date('2026-07-22T10:00:00Z'),
      ),
    ).toMatchObject({ date: '2026-07-24', time: '19:00' });
  });

  it('routes an English caller through English intent, slot prompts and availability copy', () => {
    const session = makeSession();
    session.voiceLanguageCode = 'en';
    recordUserTurn(session, 'I would like to book a table', 'content');

    expect(session.conversation.intent).toBe('reservation');
    expect(session.conversation.slots).toEqual({});
    expect(buildReservationProgressResponse(session)).toBe('What day would you like to come?');

    session.conversation.slots.date = '2026-09-11';
    session.conversation.slots.partySize = 2;
    session.conversation.slots.time = '20:00';
    expect(buildReservationProgressResponse(session)).toBeNull();
    expect(
      buildAvailabilityReply({ date: '2026-09-11', time: '20:00', partySize: 2 }, ['20:00'], 'en'),
    ).toContain('What name should I book it under?');
  });
});

// Appels réels du restaurant de démo, 23-24/09/2026 : 22 créneaux entre 12 h et 22 h 30.
const DEMO_DAY_SLOTS = [
  '12:00',
  '12:30',
  '13:00',
  '13:30',
  '14:00',
  '14:30',
  '15:00',
  '15:30',
  '16:00',
  '16:30',
  '17:00',
  '17:30',
  '18:00',
  '18:30',
  '19:00',
  '19:30',
  '20:00',
  '20:30',
  '21:00',
  '21:30',
  '22:00',
  '22:30',
];

describe('moment de la journée demandé', () => {
  it.each([
    ['Est-ce que c’est possible pour quatre personnes demain soir ?', 'dinner'],
    ['Vous avez de la disponibilité, euh, le soir ou pas ?', 'dinner'],
    ['Pour un dîner samedi', 'dinner'],
    ['Plutôt à midi', 'lunch'],
    ['Un déjeuner jeudi', 'lunch'],
    ['Dans l’après-midi', null],
    ['Pour quatre personnes', null],
  ] as const)('« %s » → %s', (transcript, expected) => {
    expect(extractDayPeriod(transcript)).toBe(expected);
  });
});

describe('réponse parlée après un échec LLM', () => {
  it('reprend le créneau vérifié et demande le nom au lieu de se taire', () => {
    const session = makeSession();
    session.conversation.slots = { date: '2026-09-25', time: '22:30', partySize: 4 };
    session.conversation.lastAvailabilityResult = {
      key: '2026-09-25:22:30:4',
      date: '2026-09-25',
      time: '22:30',
      partySize: 4,
      slots: DEMO_DAY_SLOTS,
    };

    expect(buildLlmFailurePlan(session).reply).toBe(
      'Oui, nous avons de la place pour 4 personnes à 22 h 30. À quel nom je réserve ?',
    );
  });

  it('demande de répéter quand aucun fait vérifié ne permet de répondre', () => {
    const session = makeSession();

    expect(buildLlmFailurePlan(session).reply).toBe(
      "Pardon, je n'ai pas bien entendu. Vous pouvez répéter ?",
    );
  });

  it('panne technique : dit que le souci vient de nous', () => {
    const session = makeSession();

    expect(buildLlmFailurePlan(session, 'technical').reply).toBe(
      "Désolée, j'ai eu un petit souci de mon côté. Pouvez-vous me le redire ?",
    );
  });

  it('propose le gérant après deux échecs consécutifs', () => {
    const session = makeSession();
    session.managerPhone = '+33100000000';
    session.conversation.llmFailureStreak = 2;

    expect(buildLlmFailurePlan(session).reply).toBe(
      'Je rencontre un petit souci technique. Je peux vous passer le gérant ou prendre un message. Que préférez-vous ?',
    );
  });
});

describe('heures parlées (banc STT du 24/09)', () => {
  it.each([
    ['Midi et demi.', '12:30'],
    ['Vers midi et quart', '12:15'],
    ['Vingt heures quarante-cinq.', '20:45'],
    ['20 et 1 heure.', '21:00'],
    ['20 et 1h30.', '21:30'],
    ['Vingt-deux heures trente.', '22:30'],
    ['Vers huit heures ce soir.', '20:00'],
    ['Vers 8 heures ce soir.', '20:00'],
    ['8 heures du soir', '20:00'],
    ['20 h et 1 h 30', '21:30'],
    ['vingt et 1 h 30', '21:30'],
    ['Une table lundi à 20 h et 1 h 30, c’est possible ?', '21:30'],
  ])('lit « %s » comme %s', (transcript, expected) => {
    expect(extractConversationSlots(transcript, 'Europe/Paris').time).toBe(expected);
  });

  it.each([
    ['Pour 20 heures et un enfant', '20:00'],
    ['20 heures et une personne en fauteuil', '20:00'],
    ['C’est pour midi', '12:00'],
    ['À midi', '12:00'],
    ['Midi', '12:00'],
  ])('lit « %s » comme %s (sans rien réécrire d’autre)', (transcript, expected) => {
    expect(extractConversationSlots(transcript, 'Europe/Paris').time).toBe(expected);
  });

  it.each([
    "C'est pour une repas d'après-midi.",
    'Plutôt dans l’après-midi',
    'Un repas de midi',
    'Ce midi',
  ])('« %s » ne fixe aucune heure précise', (transcript) => {
    expect(extractConversationSlots(transcript, 'Europe/Paris').time).toBeUndefined();
  });
});

describe('relecture naturelle et question fermée', () => {
  it('relit le nombre de personnes dans la question suivante', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    session.conversation.intent = 'reservation';
    session.conversation.slots.date = '2026-09-26';
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'Six personnes', 'content');

    expect(buildReservationProgressResponse(session, 'Six personnes')).toBe(
      'Six personnes, très bien. Vous voulez venir vers quelle heure ?',
    );
  });

  it('ne relit rien quand le tour n’a rien apporté', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    session.conversation.slots = { date: '2026-09-26', partySize: 6 };

    recordUserTurn(session, 'Euh', 'content');

    expect(buildReservationProgressResponse(session)).toBe('Vous voulez venir vers quelle heure ?');
  });

  it('demande « six ou seize ? » puis retient la réponse courte', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    session.conversation.intent = 'reservation';
    session.conversation.slots.date = '2026-09-26';
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'Pour super femme.', 'content');
    const plan = buildAnswerChoicePlan(session);
    expect(plan?.reply).toBe('Pardon, six ou seize personnes ?');
    expect(session.conversation.slots.partySize).toBeUndefined();

    recordAssistantReplyWithPolicy(session, plan!.reply, plan!.proposal);
    recordUserTurn(session, 'Six.', 'content');
    expect(session.conversation.slots.partySize).toBe(6);
  });

  it('ne lit pas « nos trois enfants » comme trois personnes', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'Moi, ma femme et nos trois enfants', 'content');

    expect(session.conversation.slots.partySize).toBeUndefined();
    expect(session.conversation.answerChoice).toBeNull();
  });

  it('ignore le rapprochement sans question en attente', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';

    recordUserTurn(session, 'Pour super femme.', 'content');

    expect(session.conversation.answerChoice).toBeNull();
    expect(session.conversation.lastExpectedAnswer).toBeNull();
  });

  it('ignore le rapprochement quand la question attendue est d’un autre type', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Pour quel jour ?');

    recordUserTurn(session, 'Pour super femme.', 'content');

    expect(session.conversation.slots.partySize).toBeUndefined();
    expect(session.conversation.answerChoice).toBeNull();
  });

  it('ne remplace jamais une valeur trouvée par l’analyse exacte', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'Cinq personnes', 'content');

    expect(session.conversation.slots.partySize).toBe(5);
    expect(session.conversation.lastExpectedAnswer).toBeNull();
    expect(session.conversation.phoneticAccepted).toBeNull();
  });

  it('relit dans la phrase suivante un jour retenu par rapprochement', () => {
    const session = makeSession();
    session.timezone = 'Europe/Paris';
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Pour quel jour ?');

    recordUserTurn(session, 'sa medi', 'content', new Date('2026-09-23T10:00:00Z'));

    expect(session.conversation.phoneticAccepted).toBe('date');
    expect(buildReservationProgressResponse(session, 'sa medi')).toBe(
      'Samedi 26, très bien. Vous serez combien ?',
    );
  });

  it('publie le statut et les scores sans texte', () => {
    const session = makeSession();
    session.conversation.intent = 'reservation';
    recordAssistantReply(session, 'Vous serez combien ?');

    recordUserTurn(session, 'Pour super femme.', 'content');

    expect(session.conversation.lastExpectedAnswer).toEqual({
      kind: 'partySize',
      status: 'choice',
      bestScore: expect.any(Number),
      margin: expect.any(Number),
    });
  });

  it('borne les heures candidates aux horaires d’ouverture', () => {
    expect(openingHourTimes({ sat: { open: '19:00', close: '20:00' } }, '2026-09-26')).toEqual([
      '19:00',
      '19:15',
      '19:30',
      '19:45',
    ]);
    expect(openingHourTimes(null)).toEqual([]);
  });

  it('ne propose pas les heures de la pause entre le déjeuner et le dîner', () => {
    const hours = {
      tue: {
        open: '12:00',
        close: '22:30',
        services: [
          { open: '12:00', close: '14:30' },
          { open: '19:00', close: '22:30' },
        ],
      },
    } as CallSession['openingHours'];

    const times = openingHourTimes(hours, '2026-09-29');
    expect(times).toContain('14:15');
    expect(times).toContain('19:00');
    expect(times).not.toContain('15:00');
    expect(times).not.toContain('18:00');
  });
});

describe('confirmation guidée par la confiance', () => {
  function partySizeTurn(
    transcript: string,
    words: Array<{ word: string; confidence: number }>,
    partials: string[] = [transcript],
  ): CallSession {
    const session = makeSession();
    session.restaurantId = 'restaurant-pilote';
    session.timezone = 'Europe/Paris';
    session.conversation.intent = 'reservation';
    session.conversation.slots.date = '2026-09-26';
    recordAssistantReply(session, 'Vous serez combien ?');
    session.sttEvidence = { transcript, words, partials };
    recordUserTurn(session, transcript, 'content');
    return session;
  }

  it('n’ajoute aucune question quand la valeur est sûre et stable', () => {
    const session = partySizeTurn('Six personnes', [
      { word: 'Six', confidence: 0.95 },
      { word: 'personnes', confidence: 0.9 },
    ]);
    expect(session.conversation.slots.partySize).toBe(6);
    expect(session.conversation.answerChoice).toBeNull();
    expect(buildReservationProgressResponse(session, 'Six personnes')).toBe(
      'Six personnes, très bien. Vous voulez venir vers quelle heure ?',
    );
  });

  it('demande « six ou dix ? » quand « six » est peu sûr', () => {
    const session = partySizeTurn('Six personnes', [
      { word: 'Six', confidence: 0.2 },
      { word: 'personnes', confidence: 0.9 },
    ]);
    expect(session.conversation.slots.partySize).toBeUndefined();
    expect(buildAnswerChoicePlan(session)?.reply).toBe('Pardon, six ou dix personnes ?');
  });

  it('demande un choix quand la valeur a changé dans les partielles', () => {
    const session = partySizeTurn(
      'Six personnes',
      [
        { word: 'Six', confidence: 0.95 },
        { word: 'personnes', confidence: 0.9 },
      ],
      ['Dix', 'Dix personnes', 'Six personnes'],
    );
    expect(session.conversation.answerChoice).toEqual({ kind: 'partySize', values: ['6', '10'] });
  });

  it('redemande autrement une valeur très douteuse sans voisin', () => {
    const session = partySizeTurn('Quatre personnes', [
      { word: 'Quatre', confidence: 0.05 },
      { word: 'personnes', confidence: 0.9 },
    ]);
    expect(session.conversation.slots.partySize).toBeUndefined();
    expect(buildDeterministicTurnResponse(session, 'content', 'Quatre personnes')).toBe(
      "Pardon, je n'ai pas bien entendu le nombre de personnes. Vous serez combien ?",
    );
  });

  it('fait confirmer une heure hors des horaires d’ouverture', () => {
    const session = makeSession();
    session.restaurantId = 'restaurant-pilote';
    session.timezone = 'Europe/Paris';
    session.openingHours = { sat: { open: '19:00', close: '23:00' } };
    session.conversation.intent = 'reservation';
    session.conversation.slots = { date: '2026-09-26', partySize: 4 };
    recordAssistantReply(session, 'Vous voulez venir vers quelle heure ?');
    session.sttEvidence = {
      transcript: 'À 8 heures',
      words: [
        { word: 'À', confidence: 0.9 },
        { word: '8', confidence: 0.95 },
        { word: 'heures', confidence: 0.9 },
      ],
      partials: ['À 8 heures'],
    };

    recordUserTurn(session, 'À 8 heures', 'content');

    expect(session.conversation.slots.time).toBeUndefined();
    expect(buildAnswerChoicePlan(session)?.reply).toBe('Pardon, 8 h ou 20 h ?');
  });

  it('retient la réponse courte à « six ou dix ? »', () => {
    const session = partySizeTurn('Six personnes', [{ word: 'Six', confidence: 0.2 }]);
    const plan = buildAnswerChoicePlan(session)!;
    recordAssistantReplyWithPolicy(session, plan.reply, plan.proposal);
    session.sttEvidence = null;

    recordUserTurn(session, 'Six.', 'content');

    expect(session.conversation.slots.partySize).toBe(6);
  });

  it('publie une télémétrie sans texte ni valeur', () => {
    const session = partySizeTurn('Six personnes', [{ word: 'Six', confidence: 0.123 }]);
    const [entry] = session.conversation.lastSlotConfidence!;
    expect(Object.keys(entry).sort()).toEqual(['confidence', 'decision', 'kind', 'unstable']);
    expect(entry).toEqual({
      kind: 'partySize',
      confidence: 0.12,
      unstable: false,
      decision: 'choice',
    });
  });

  it('ignore des preuves STT qui portent sur une autre phrase', () => {
    const session = makeSession();
    session.restaurantId = 'restaurant-pilote';
    session.conversation.intent = 'reservation';
    session.conversation.slots.date = '2026-09-26';
    recordAssistantReply(session, 'Vous serez combien ?');
    session.sttEvidence = {
      transcript: 'autre chose',
      words: [{ word: 'Six', confidence: 0.1 }],
      partials: [],
    };
    recordUserTurn(session, 'Six personnes', 'content');
    expect(session.conversation.slots.partySize).toBe(6);
  });
});
