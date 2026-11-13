# Qualification de la démonstration vocale (VOICE-01)

**Date de préparation** : 13/10/2026. **Statut** : non exécutée. Aucun appel n'a été passé. Aucun
résultat ne figure dans cette fiche tant qu'un essai réel n'a pas été joué et consigné.

## 1. Périmètre

Cette fiche qualifie le résultat métier d'un appel traité par le pipeline de production, avec les
vrais fournisseurs : téléphonie Telnyx, STT (`VOICE_STT_PROVIDER`, ElevenLabs par défaut), LLM
(`VOICE_LLM_PROVIDER`, `VOICE_LLM_MODEL`) et TTS Cartesia. Le résultat se lit dans le dashboard du
restaurant de test, pas seulement à l'écoute.

Elle ne qualifie pas :

- l'animation et les maquettes de la page d'accueil ;
- la lecture TTS d'un script ;
- la démonstration en direct de l'onboarding, qui exige un compte restaurateur authentifié.

Le niveau de preuve de chaque dispositif est décrit à la section 4 du
[rapport de qualification](2026-10-13-growth-execution.md).

## 2. Deux niveaux, dans cet ordre

Ne pas confondre la validation du provisioning et la qualification conversationnelle. La première
prouve que l'appel arrive au bon endroit ; la seconde prouve que l'assistant prend la bonne
réservation.

| Niveau                                      | Ce qui est vérifié                                                    | Étapes et preuves                                                                                                                                                                         | Ce qu'il ne prouve pas                          |
| ------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Validation du provisioning (opérateur)   | Numéro attribué, webhook vérifié, renvoi confirmé, appel de test reçu | `assign-phone`, `verify-webhook`, `mark-forwarding`, `test-call`, puis `validate-test-call` avec le `callControlId` retourné ; `complete` accepté seulement sans `PROVISIONING_NOT_READY` | La qualité de la conversation et la réservation |
| 2. Qualification conversationnelle (métier) | Réservation exacte dans le dashboard, puis les sept scénarios         | Premier appel de réservation (section 4), puis scénarios (section 5)                                                                                                                      | Le comportement sous charge et les pilotes      |

Le niveau 2 dépend du seul bloc voix entrante (runbook, section fournisseurs de staging). Le niveau 1 (appel de test sortant) est un contrôle distinct : il conditionne la validation du provisioning, pas l'appel de réservation.

## 3. Prérequis à vérifier avant chaque session

| Prérequis                                                                                                                                                                         | Responsable               | Contrôle                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| Restaurant de test sur staging, sans établissement client ni donnée client                                                                                                        | Équipe technique          | Identifiant opaque consigné dans le journal des essais                      |
| Numéro de test Telnyx rattaché à ce restaurant de test uniquement (`TELNYX_CONNECTION_ID`)                                                                                        | Équipe technique          | L'appel reçoit la réponse de l'assistant ; aucun renvoi vers un numéro réel |
| Test d'appel sortant du provisioning : `connectionId` transmis, webhook `POST /voice/telnyx`, état `onboarding_test_call` traité (correction de code)                             | Équipe technique          | Test d'appel validé avant `validate-test-call`                              |
| Appelant disposant du numéro de test                                                                                                                                              | Hamza ou équipe technique | Numéro non publié, ni dans le dépôt ni dans les captures                    |
| Session opérateur sur staging, nécessaire aux routes de provisioning                                                                                                              | Hamza                     | Connexion opérateur effectuée avant le niveau 1                             |
| Environnement, commit déployé et valeurs des variables `VOICE_*` relevés au moment de l'essai (noms dans `apps/api/.env.example`)                                                 | Équipe technique          | Ligne complète dans le journal des essais                                   |
| Accès en lecture au dashboard du restaurant de test, pour lire les réservations créées                                                                                            | Hamza ou équipe technique | Relevé de la réservation (identifiant opaque, créneau, effectif, statut)    |
| Rejeux LLM : la clé Cerebras sert aussi la production. Aucun rejeu sans plafond de requêtes et contrôle du solde (voir l'en-tête de `apps/api/scripts/voice-behavior-replay.mjs`) | Équipe technique          | Plafond consigné avant le lancement                                         |

## 4. Premier appel guidé de réservation (passerelle du niveau 2)

Avant les sept scénarios, Hamza passe un appel de réservation simple, guidé par le script ci-dessous.
L'appel ne démarre que lorsque les conditions suivantes sont réunies :

- bloc voix entrante prêt : clés Telnyx, application d'appel et numéro de test rattaché, sans appel de test sortant ;
- `VOICE_DISABLED=false` en staging, décidé par l'équipe, et `GET /health` avec `telnyx` à `ok` ;
- restaurant `chez-sokar-demo` sur staging : numéro de test attribué, créneau libre à la date choisie.

**Script de l'appel** (à remettre à Hamza avec le numéro vérifié) :

1. Appeler le numéro de test : `[numéro vérifié — à fournir]`.
2. Dire : « Bonjour, je voudrais réserver une table pour deux personnes demain à vingt heures, au nom
   de Test Suppernote. »
3. Répondre aux questions de l'assistant avec les mêmes éléments, sans en ajouter.
4. Confirmer le créneau proposé, puis raccrocher.

**Résultat attendu**, vérifié dans le dashboard du restaurant de test :

- une réservation pour le lendemain, à vingt heures, pour deux personnes, au nom « Test Suppernote » ;
- statut confirmé, et une seule réservation créée ;
- l'heure de l'appel et la réservation concordent dans les traces métier autorisées.

**Relevé** : date et heure de l'appel, environnement et commit, identifiant opaque de la réservation,
résultat, dans le journal des essais (section 10). Si un point échoue, les scénarios ne sont pas joués :
la cause est corrigée ou documentée, puis l'appel est rejoué.

## 5. Scénarios (niveau 2)

Les sept scénarios du plan (section 7) sont à jouer dans cet ordre. Le résultat attendu est un
résultat métier, vérifié dans le dashboard.

| #   | Scénario                       | Déroulé de l'appelant                                                                       | Résultat métier attendu                                                             |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Demande simple                 | Demande une table pour un nombre de personnes à un créneau libre, puis répond aux questions | Une seule réservation, avec le créneau, l'effectif et les informations exacts       |
| 2   | Changement pendant l'appel     | Annonce une demande, puis la modifie (heure ou effectif) avant la fin                       | La demande finale remplace l'intention précédente ; une seule réservation exacte    |
| 3   | Restaurant complet             | Demande un créneau déjà saturé                                                              | Aucune réservation créée ; réponse et alternative cohérentes                        |
| 4   | Nom ou heure ambigus           | Donne un prénom seul ou une heure imprécise (« vers huit heures »)                          | Clarification avant toute écriture ; aucune réservation prématurée                  |
| 5   | Question pratique              | Pose une question hors réservation (accès, allergènes, parking)                             | Information vérifiée, ou transfert ou solution de secours ; aucune réponse inventée |
| 6   | Reprise ou répétition          | Rappelle, ou répète la demande après la fin du premier appel                                | Pas de doublon ; l'appel et le dashboard concordent                                 |
| 7   | Service ou fournisseur dégradé | Dégradation contrôlée décidée par l'équipe technique, en staging uniquement                 | Secours réel, comportement annoncé, aucune perte silencieuse de demande             |

Le scénario 7 n'est joué qu'en staging, avec une coupure décidée et consignée à l'avance. Il ne
se joue jamais en production.

## 6. Règles de calcul

- **Dénominateur** : tous les essais joués, y compris les échecs, les coupures et les incidents
  techniques. Ne jamais ne retenir que les essais réussis.
- **Essai annulé pour une raison de test** (numéro mal routé, coupure réseau côté appelant) : consigné
  à part avec son motif. Il ne compte ni comme réussite ni comme échec, mais il reste visible.
- **Lecture** : le résultat est validé par le relevé de réservation dans le dashboard, pas par
  l'audio seul.
- **Un essai isolé** s'affiche comme un cas observé, jamais comme un taux.
- **Mise à jour** : rejouer le premier appel et les sept scénarios après tout changement significatif
  du pipeline voix (STT, LLM, TTS, prompts, variables `VOICE_*`).

## 7. Preuves à archiver

- **Audio** : enregistré pour usage de test, anonymisé avant tout archivage public.
- **Transcription** : texte horodaté, sans numéro, nom ni adresse réels.
- **Relevé de réservation** : identifiant opaque, créneau, effectif, statut.
- **Callcontrol** : `callControlId` retourné par Telnyx, pour le niveau 1.
- **Ligne du journal** : date (UTC), environnement, commit, scénario, essai, résultat, motif en cas
  d'échec.

Aucune de ces preuves ne contient de donnée personnelle. Aucune n'est versée dans le dépôt sans
anonymisation préalable.

## 8. Critère de sortie

La démonstration est qualifiée lorsque :

- le niveau 1 est validé, avec le `callControlId` consigné ;
- le premier appel de réservation (section 4) est exact dans le dashboard ;
- les sept scénarios ont été joués, dénominateur complet à l'appui ;
- la réservation finale est exacte pour chaque scénario qui doit en créer une ;
- les limites et le secours sont compris et écrits dans la fiche ;
- aucun défaut bloquant n'est ouvert selon le runbook pilote.

## 9. État actuel

- **Niveau 1 (provisioning)** : non exécuté. Le restaurant de test et le numéro de test n'ont pas
  été renseignés (gabarits `[référence]` et `[informations]` dans la demande du 13/10/2026).
- **Niveau 2 (conversation)** : 0 appel, premier appel de réservation non joué, 0 sur 7 scénarios.
- **Dépendances réelles** :

| Dépendance                                                                           | Responsable               | Conséquence si elle manque                                |
| ------------------------------------------------------------------------------------ | ------------------------- | --------------------------------------------------------- |
| Session opérateur sur staging                                                        | Hamza                     | Niveau 1 impossible                                       |
| Correction du test d'appel sortant (code)                                            | Équipe technique          | Niveau 1 impossible : le test d'appel ne peut pas aboutir |
| Restaurant de test sur staging et numéro de test routé vers lui                      | Équipe technique          | Aucun appel possible                                      |
| Appelant disposant du numéro de test                                                 | Hamza ou équipe technique | Aucun scénario joué                                       |
| Compte restaurateur de test (uniquement si la démonstration en direct est qualifiée) | Hamza                     | Démonstration en direct non qualifiable                   |

Search Console n'est pas une dépendance de cette qualification.

## 10. Journal des essais

| Date (UTC) | Environnement | Commit | Niveau / scénario | Essai | Résultat | Preuve | Motif si échec |
| ---------- | ------------- | ------ | ----------------- | ----- | -------- | ------ | -------------- |
| —          | —             | —      | —                 | —     | —        | —      | —              |
